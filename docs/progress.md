# Progress

## M0: prove the base — DONE (2026-10-17)

**Implemented behavior**
- Single-package repo, strict TypeScript (`tsconfig.json`, `strict: true`), one lockfile.
- Pi pinned to exact `@earendil-works/pi-coding-agent@1.3.0`; lockfile committed.
- Local llama.cpp endpoint (`http://127.0.0.1:8080/v1`, model `qwen38`) verified reachable and resolvable through `ModelRuntime.create({ refreshOnCreate: false })` → `getModel("local","qwen38")` (ctx=98304, max=8192). No secrets stored in project config.
- API assumptions verified against installed `.d.ts` files and recorded in `docs/upstream.md`. Two adapter bugs found and fixed: (1) `message_update` deltas are nested under `assistantMessageEvent`, not top-level; (2) `agent_end` is per-turn — `agent_settled` is the real run terminator.

**Commands/checks and outcomes**
- `npm run typecheck` → clean
- `npm run build` → clean
- `node --input-type=module -e "import { ModelRuntime } ..."` → provider `local` + model `qwen38` resolve ✓
- `curl http://127.0.0.1:8080/v1/models` → qwen38 listed ✓

**Known limitation / blocker**
- None. Real-model smoke test passed (see below).

**Next action**
- M1: focused unit tests, then M2: task controller, state persistence, resume.

### M0 ticket 5 — real-model smoke test: PASSED (2026-10-17)

Command:
```
npx tsx src/cli.ts run "There is an off-by-one bug in src/sum.ts: ... Fix the bug ... then run 'npm test' to verify all tests pass." --cwd evals/fixtures/offbyone
```

Outcome: model performed read → edit (`i < n` → `i <= n`) → bash `npm test`; 3 tool calls, 24222 tokens. Final response reported all tests pass. Independently re-verified: `src/sum.ts` contains `i <= n` and `npm test` prints `ALL TESTS PASSED`. Local llama.cpp tool-calling works end-to-end through the harness.

## M1: useful agent — DONE (evidence: "M1 evidence" section at bottom)

Remaining M1 gap (interactive mode unexercised against live model) carried in M2 "Known limitation".

## M2: task controller, persistence, resume — DONE (2026-10-17)

**Implemented behavior**
- `src/task/types.ts`: task schema v1 — lifecycle phases (pending → inspecting → implementing → verifying → completed; terminal: blocked/failed/cancelled), acceptance checks (optional verification command), limits, budgets (tool calls, seconds, repair cycles), Pi session refs, workspace baseline (git HEAD + dirty paths at start).
- `src/task/store.ts`: `.harness/state/tasks/<id>.json` persistence with atomic write (temp + rename), schema validation (`SchemaError`), workspace lock with stale-lock recovery (`acquireLock`, `LockError`), `findActiveTask`/`listTaskIds`.
- `src/task/controller.ts`: `runTask()` — create/resume task, workspace reconciliation on resume (HEAD changed → blocked, not blind continue; baseline paths no longer dirty → reported), implementation run, verification via check commands, bounded repair loop (default 2 cycles) that stops early on repeated identical failures (signature = check line + last 500 chars of output), budget exhaustion → blocked, final state + changed-paths persist.
- `src/cli.ts`: new commands — `harness task "goal" [--check "description|command" ...]`, `harness resume [id]` (defaults to most recent active task), `harness status [id]` (defaults to active; no id + none active lists all). SIGINT during a managed task marks the record `cancelled` and exits 130. Exit code 0 only when phase is `completed`.
- Failure-detection fix: repair-loop signature now includes check output tail (was line-only, which made `maxRepairCycles` unreachable for persistent failures).
- Test runner fix: `npm test` now uses `tsx --test tests/*.test.ts` (node type-stripping does not rewrite `.js`→`.ts` import specifiers in transitively imported modules).

**Commands/checks and outcomes**
- `npm run typecheck` → clean
- `npm run build` → clean
- `npm test` → 33/33 pass (config 5, events 14, task-store 10, controller 4: first-pass complete, bounded repair (1 cycle, repair prompt verified), identical-failure early stop (impl + 1 repair only), repair-budget exhaustion with varying evidence)
- Real-model smoke test (managed task, local qwen38): PASSED
  ```
  npx tsx src/cli.ts task "There is an off-by-one bug in src/sum.ts: sum(n) must return 1+2+...+n (e.g. sum(3) = 6). Fix the bug in src/sum.ts only, then run 'npm test' to verify." --check "sum tests pass|npm test" --cwd evals/fixtures/offbyone
  ```
  Outcome: task `task-mvcdrpdi-f8o60n` → phase `completed`, budget 4/40 tool calls, repair 0/2, check `c1: sum tests pass — PASS`, Pi session `01a149dd-064e-7515-96a5-0af3b410066d`, exit 0. Independently verified `src/sum.ts` now uses `i <= n` and `npm test` passes; fixture restored to buggy state afterwards.
- `harness status --cwd evals/fixtures/offbyone` → lists completed task; `harness resume` with no active task → clean error, exit 1.

**Known limitation / blocker**
- Resume creates a **fresh** Pi session (re-prompts the goal); it does not restore the original Pi conversation (we store the session ref but do not replay it).
- Repair loop and resume are proven with unit tests (fakes) + the completed-path real-model smoke; a real-model run that actually *fails* a check and consumes a repair cycle has not been observed end-to-end.
- Interactive mode still not exercised against the live model (M1 residual).

**Next action**
- M3: context service (`src/context/`) — project facts (`.harness/memory.json`) + skill selection injected into task prompts; `harness memory` command.

## M3: context service — memory facts + skill selection — DONE (2026-10-17)

**Implemented behavior**
- `src/context/memory.ts`: project facts at `<ws>/.harness/memory.json` (gitignored, atomic write via new shared `src/fsutil.ts:atomicWriteJson`, also reused by `src/task/store.ts`). `loadMemory` (missing → empty; corrupt JSON / wrong schema → `MemoryError`, never silent), `addFact` (max 500 chars / 200 facts, tags lowercased), `removeFact` (unlinks file when empty).
- `src/context/skills.ts`: discovers approved skills at `<ws>/.harness/skills/<name>/SKILL.md`; title = first `# ` heading (else dir name), description = first prose line (fence-skipped, ≤240 chars). Proposals/state dirs are never discoverable (M4 boundary).
- `src/context/selection.ts`: deterministic relevance — goal tokens (lowercase alnum ≥3 chars) scored against fact text+tags and skill title/description/name; facts sorted score-desc then most-recent; no-match → up to 3 most-recent fallback facts marked `(general project note)`; skills capped at 3, body budget enforced (~4 chars/token). Budgets: 1000 tokens memory / 2000 tokens skills (docs/architecture.md).
- `src/context/index.ts`: `buildContextBlock(workspace, goal)` renders the markdown block ("Project notes …" + "Relevant skills …"), empty string when nothing selected.
- Injection: `controller.ts:buildPrompt` prepends the block to the implementation prompt only (repair prompt stays failure-focused); `cli.ts runManagedTask` builds it per task — `MemoryError` → warn + continue without context, other errors rethrow. New `harness memory list|add|remove` command with `--tag` / `--source user|verified`.

**Commands/checks and outcomes**
- `npm run typecheck` → clean; `npm run build` → clean.
- `npm test` → 47/47 pass (config 5, events 14, task-store 10 incl. 3 workspace-lock tests, controller 4, context 14). `tests/context.test.ts` covers memory round-trip, corrupt-file `MemoryError`, bad-schema `MemoryError`, empty-fact rejection, skill parse/fallback-title, matched-fact ranking, no-match fallback recency, 3-skill cap + body budget, goalTokens/estimateTokens, render format, e2e `buildContextBlock`.
- Real-model context-injection smoke (qwen38 @ `http://127.0.0.1:8080/v1`, `evals/fixtures/offbyone`): seeded `memory add "…must stay exported as sum…" --tag sum --tag api --source verified` + a `sum-tests` SKILL.md, then
  ```
  npx tsx src/cli.ts task "off-by-one sum(n): 1+..+n returns wrong total" --check "sum tests pass|npm test" --cwd evals/fixtures/offbyone
  ```
  → CLI printed `Context: memory facts and/or skills selected for this goal.`, task `task-mvcf6zc1-kuhnv2` → `completed`, 5/40 tool calls, repair 0/2, check `c1 PASS`, exit 0, Pi session `01a14a01-8784-745d-bf66-7fbbd114eb10`. The agent's final message cited the injected skill: "(`npm test`, per the sum-tests skill)" — proof the block reached the model. Fixture restored (`git checkout` + removed `.harness`).

**Known limitation / blocker**
- Relevance is substring token matching — crude (no stemming/embeddings); adequate at this scale.
- Skills are injected by name match only; there is no automatic skill creation yet (M4).
- Context block is built once per task start; facts added mid-task are not picked up.

**Next action**
- M4: learning service (`src/skills/`) — propose new skills from completed tasks, store under `.harness/state/proposals/`, approve into `.harness/skills/`.

## M4: learning service — propose → evaluate → promote — DONE (2026-10-17)

**Implemented behavior**
- `src/skills/types.ts`: `SkillProposal` schema v1 (name, title, description, body, sourceTaskId, verifyCommands, status proposed/approved/rejected, evalResult, timestamps), `SkillError`.
- `src/skills/proposals.ts`: deterministic, LLM-free drafting from a `TaskRecord` (`proposeFromTask`) — only `phase: completed` tasks qualify (learning from a failed run would encode the wrong procedure). Draft captures Goal / What worked (changed paths) / Verify (check commands), slug derived from the goal with `-2…-9` dedupe against existing proposals and approved skills, name validated (`^[\w-]{1,64}$`, so no path traversal). `renderSkillMd` emits the same `# title` + prose-line shape the M3 parser expects. Proposals live in `.harness/state/proposals/<name>/proposal.json`, which `src/context/skills.ts` never reads.
- `src/skills/evaluate.ts`: `evaluateProposal` runs the proposal's verify commands in the workspace in order, stops at first failure, writes an immutable manifest to `.harness/state/evals/<name>-<ts>.json` and stamps `evalResult` on the proposal. A proposal with no verify commands can never pass.
- `src/skills/promote.ts`: `approveProposal` requires `status: proposed` **and** `evalResult.passed` (evaluation → promotion gate); writes `.harness/skills/<name>/SKILL.md`, snapshotting any previous content with a sha256 into `.harness/state/skill-versions/<name>/`. `rejectProposal` keeps the record (never active). Re-approving or approving a rejected proposal is an error.
- `src/cli.ts`: `harness skill propose <taskId> | list | show <name> | evaluate <name> | approve <name> | reject <name>`; evaluate sets exit code 1 when the commands fail; `SkillError` → message + exit 1.
- Bug found and fixed during this slice: `parseArgs` was missing a `break` after `case "memory":` (plus a duplicated `break`), so `harness memory …` fell through and ran the `skill` command. Fixed in `src/cli.ts`; verified by running `memory add` / `memory list` through the built CLI.
- Bug found and fixed in M3's renderer while checking promoted-skill injection: the skill body was injected with its own `# Title` heading *and* the `### name: title` block heading, so the model read the title twice. `renderSelection` now strips the leading H1; covered by a new test.
- Housekeeping: repo files had drifted to mode 755 (now 644); `npm install` re-linked `node_modules/.bin` (tsc/tsx were missing, so the gates could not run).

**Commands/checks and outcomes**
- `npm run typecheck` → clean; `npm run build` → clean.
- `npm test` → 63/63 pass (config 5, events 14, task-store 10, controller 5, context 15, skills 14). `tests/skills.test.ts` covers: draft from completed task, rejection of non-completed tasks, slug dedupe, path-traversal name rejection, proposal persistence round-trip, corrupt-file tolerance, list/show, evaluate pass, evaluate fail (stop at first failure) + manifest content, no-commands → cannot pass, approve-without-eval rejection, approve writes SKILL.md + version snapshot on overwrite, reject transitions, re-approve/re-reject errors, approved proposal discoverable by context service while unapproved ones are not.
- CLI chain end-to-end in a scratch workspace (`/home/hati/.hermes/cache/scratch/m4e2e`, git repo with `src/sum.ts` + `check.mjs`), seeded with a **synthetic** completed task record (see blocker):
  ```
  node dist/cli.js skill propose task-e2e-m4 --cwd "$WS"
    → Proposed fix-off-by-one-in-sum-n-so-it-returns-1-n
  node dist/cli.js skill approve <name>            → "has not passed evaluation" (exit 1) ✓ gate holds
  node dist/cli.js skill evaluate <name>
    → PASS  node check.mjs / Evaluation: PASS (exit 0)
  node dist/cli.js skill list                       → [proposed] eval=PASS
  node dist/cli.js skill approve <name>             → approved, SKILL.md written
  node dist/cli.js skill approve <name> (again)     → "already approved" (exit 1) ✓
  ```
  `.harness/` afterwards: `skills/<name>/SKILL.md`, `state/proposals/<name>/proposal.json`, `state/evals/<name>-<ts>.json`, `state/tasks/task-e2e-m4.json`. `buildContextBlock(ws, "off-by-one sum(n) returns wrong total")` returns the promoted skill (title once, verify command present) — the learning loop closes from draft to injection.

**Known limitation / blocker**
- **Real-model smoke test not run: the local endpoint is down.** `curl http://127.0.0.1:8080/v1/models` → no response (`doctor` prints `Local endpoint http://127.0.0.1:8080: ✗ not reachable`); no `llama-server` binary, no Ollama, no GGUF weights on this machine right now. Per AGENTS.md the M4 integration milestone therefore is **not** claimed complete: the chain above was driven by a synthetic `completed` task record, not by a model-authored task. Everything model-independent is proven.
- Drafts are templated from the task record; there is no model-written reflection step, so a promoted skill is a verified procedure summary, not a distilled insight.
- Promotion gate only re-runs the recorded verify commands in the *current* workspace — a skill learned in a repo where those commands no longer apply can pass evaluation vacuously on a trivially succeeding command. `harness skill evaluate` has no timeout override (120s hard-coded).
- `skill evaluate` runs on the live workspace (no scratch copy), so a side-effecting verify command mutates the tree being evaluated.

**Next action**
- M5: evaluation harness — run scenarios from `evals/scenarios/` and record evidence.

## M5: evaluation harness — scenario runner — DONE (2026-10-17)

**Implemented behavior**
- `evals/scenarios/*.json` is the scenario format: `name`, `description`, `fixture` (resolved relative to the scenario file), `goal`, `checks[]` (`description` + optional `command`), optional `limits` (`maxToolCalls`, `maxTaskMinutes`, `maxRepairCycles`). Shipped scenario: `evals/scenarios/offbyone-fix.json` over `evals/fixtures/offbyone`.
- `src/eval/scenarios.ts`: pure loading/validation (`schemaVersion` 1, name `^[\w-]{1,64}$`, fixture must exist, checks non-empty, limits numeric with `maxRepairCycles: 0` allowed because "no repair loop" is a real setting while a 0 tool-call/time budget is not). `EvalError` carries the file and field.
- `src/eval/runner.ts`: per run it copies the fixture into `.harness/state/evals/<scenario>-<base36>/work` (skipping `node_modules`, `.git`, `.harness`), copies the repo's `.harness/memory.json` and `.harness/skills/` in so a run exercises exactly the learned context that would be injected, and commits a git baseline so the controller can report changed paths. Task execution is an injected `ScenarioRunner`, so this module imports no Pi and is testable without a model. A manifest is written in a `finally` — a crashed or unreachable-backend run is recorded as `phase: "error"` evidence instead of vanishing. Fixture limits override harness defaults per key.
- `src/eval/index.ts`; CLI `harness eval list`, `harness eval run <name>`, `harness eval run --all`, `--dry-run` (validates and prints the resolved plan without touching a model), exit code 1 when any scenario fails.
- Fixes found while wiring this up:
  - `parseArgs` re-read subcommand words as top-level commands: `eval run offbyone-fix` set `command = "run"` on the word "run" and launched a *task* named offbyone-fix instead. Subcommand commands (`memory`, `skill`, `eval`) now consume their positionals before the keyword switch.
  - After the backend refused connections, the process hung well past `tools=0 → task finished` because Pi's client keeps sockets/timers alive. Added an explicit flush-then-exit (`shutdown`) at the end of `main`; the same run now exits with code 1 in ~29s.
  - `runManagedTask`'s streaming prompt and shell-check closures were extracted to `streamedRunPrompt` / `shellCheckRunner` so the scenario runner reuses the exact same plumbing instead of a copy.

**Commands/checks and outcomes**
- `npm run typecheck` → clean; `npm run build` → clean.
- `npm test` → 72/72 pass (config 5, events 14, task-store 10, controller 5, context 15, skills 14, eval 9). `tests/eval.test.ts` covers: fixture resolution, limits parsing (incl. rejected 0 tool calls), invalid definitions (bad name, missing fixture, empty goal, empty checks, wrong schemaVersion), missing scenarios dir, fixture copy with `.git`/`node_modules` exclusion and source left pristine, passing manifest (incl. on-disk equality with the returned one), failing task → `passed: false` + outcome, crashing runner recorded as `error` rather than thrown, per-key limit override, and memory/skills copied into the run workspace with `contextSkills` recorded.
- CLI against the real scenario:
  ```
  node dist/cli.js eval list        → offbyone-fix, fixture ../fixtures/offbyone, check c1 (npm test)
  node dist/cli.js eval run offbyone-fix --dry-run
    → fixture absolute path, goal, limits {"maxToolCalls":20,"maxTaskMinutes":10}; "nothing executed"
  node dist/cli.js eval run offbyone-fix
    → FAIL offbyone-fix phase=failed tools=0 repairs=1 29s; 0/1 scenario(s) passed; exit 1
      evidence: .harness/state/evals/offbyone-fix-mvcn52pf
  ```
  The manifest records `phase: "failed"`, both validation attempts (`c1 … — FAIL`), the outcome (`Checks failed and repair produced no new evidence`), `contextSkills: []`, and the task id; `work/` holds the isolated copy (own `.git`, copied `.harness`), and `evals/fixtures/offbyone/src/sum.ts` is unchanged.

**Known limitation / blocker**
- **No scenario has passed yet — the local endpoint is still down** (`127.0.0.1:8080` refuses connections; the run above retried 3×, then failed its checks with 0 tool calls). The harness now *measures*; there is nothing yet to measure. M5 stays CODE COMPLETE until one scenario passes against a real model.
- Runs are sequential and each writes its own manifest: no aggregate score file or trend yet, so comparing two runs means diffing JSON by hand.
- Fixtures must be dependency-free (their `node_modules` is not copied); a fixture that needs `npm install` cannot currently be evaluated.
- `contextSkills` records skill names only, not the rendered context block, so a manifest shows *that* context was injected but not its exact text.
- Whole-scenario wall-clock is unbounded (`maxTaskMinutes` governs the task inside it, not the copy/check step).

**Next action**
- Start the endpoint, run `harness eval run offbyone-fix`, confirm `PASS` and that `work/src/sum.ts` holds the fix; record the manifest here and flip M5 to DONE.
- Then M6: scoreboard — append every manifest to a single `evals/history.jsonl` and add `harness eval score` comparing pass rate / tool calls / repair cycles across runs, which is what makes "gets better at recurring work" checkable over time.

## M6: scoreboard — append-only history + `eval score` — DONE (2026-10-17)

**Implemented behavior**
- `src/eval/history.ts`: every scenario run appends one JSON line to `.harness/state/evals/history.jsonl` (`at`, `scenario`, `passed`, `phase`, `toolCalls`, `repairCycles`, `seconds`, `model`, `runDir`). Manifests stay the per-run source of truth; the history file exists so trends do not require walking directories. Append is best effort — a read-only `.harness` cannot turn a finished run into a failure.
- `readHistory` skips malformed/truncated lines and re-types missing counters to `0`, so one bad write cannot make the rest of the history unreadable. `summarizeHistory` aggregates per scenario: runs, passed, pass rate, best/avg tool calls, best duration, and the most recent entry.
- `runScenario` appends in the same `finally` that writes the manifest, so a crashed run is scored too.
- CLI `harness eval score [name]` prints the aggregate plus the last run's timestamp, outcome, model and evidence path.
- `history.ts` imports `ScenarioManifest` as a type-only import on purpose: a value import from `runner.ts` would be a runtime cycle since `runner.ts` imports `appendHistory`.

**Commands/checks and outcomes**
- `npm run typecheck` → clean; `npm run build` → clean; `npm test` → 76/76 pass (4 new history tests: append format/round-trip, missing file + malformed lines, aggregation maths, and a real `runScenario` appending itself).
- Real CLI run, then score:
  ```
  node dist/cli.js eval run offbyone-fix   → FAIL, exit 1, evidence .harness/state/evals/offbyone-fix-mvcn7tfc
  node dist/cli.js eval score              → offbyone-fix | runs 1  passed 0 (0%)  best tools 0  avg tools 0.0  best 28.7s
                                             last: … FAIL phase=failed local/qwen38
  node dist/cli.js eval score offbyone-fix → identical (filter path)
  ```
  `history.jsonl` holds exactly one line, matching the manifest.

**Known limitation**
- The scoreboard measures, but there is still nothing to compare: the only recorded run is the blocked one (`0%`, 0 tool calls, backend unreachable).
- Averaging tool calls across failed runs that never called a tool pulls the average toward zero; a nicer statistic (passed-runs-only cost) needs a decision, not a guess.
- `seconds` is wall-clock including fixture copy and check execution, not model time.

**Next action**
- Unblock the backend, then `eval run --all` twice: the second run's history line proves the loop records comparable evidence (pass rate, cost per run).
- Then M7: use the scoreboard for the actual product claim — run `offbyone-fix` with and without the learned skill promoted in M4 and compare pass rate/cost, i.e. evidence that learning helps rather than an assertion.

## M7: A/B arms — measure the skills, not just the run — DONE (2026-10-17)

**Implemented behavior**
- A run now belongs to a `variant`. `skills` (default) copies `.harness/skills/` into the run workspace; `no-skills` (`--no-skills`) copies `memory.json` but no procedures. The arm is a property of the *workspace*, not a flag inside the context service — so the injected context is genuinely absent rather than rendered-then-filtered, and nothing in `src/context/` needs to know evaluations exist.
- Manifests record `variant` and the run directory gains a `-noskills` suffix, so two arms never collide on a timestamp.
- History entries carry `variant`; `summarizeHistory` groups by (scenario, variant) and sorts baseline-first. Pooling arms would hide the exact difference the scoreboard exists to show, so it is not offered.
- CLI: `harness eval run <name> --no-skills`, `eval score` prints one block per arm with `[skills]` / `[no-skills]`.
- Older history lines written before M7 have no `variant` and are read as `skills` — the file is append-only and must not need rewriting.

**Commands/checks and outcomes**
- `npm run typecheck` → clean; `npm run build` → clean; `npm test` → 78/78 (2 new tests: end-to-end arm capture proving the baseline workspace has no skills directory while the skills arm carries the promoted one, and arm-separated aggregation).
- CLI, both arms against the same scenario:
  ```
  node dist/cli.js eval run offbyone-fix --no-skills
    → FAIL offbyone-fix [no-skills] … evidence .harness/state/evals/offbyone-fix-noskills-mvco9wl0
  node dist/cli.js eval score
    → offbyone-fix [no-skills]  runs 1  passed 0 (0%)  best 28.8s
      offbyone-fix [skills]     runs 1  passed 0 (0%)  best 28.7s
  ```
  Two separate rows, each pointing at its own evidence directory.

**Known limitation**
- There is still no promoted skill in this repo (M4's learning chain has never run end to end), so both arms are currently **identical by construction** — they differ only in the `variant` label. The A/B machinery is real; the experiment it enables is not yet possible.
- Backend still down; both arms fail with 0 tool calls, so no cost comparison exists either.

**Next action**
- Unblock the backend → run the M4 chain to promote a real skill → `eval run --no-skills` and `eval run` → compare the two arms. That is the first honest answer to "does the harness get better at recurring work?"

## M1 evidence (2026-10-17)

**Implemented behavior**
- `src/cli.ts`: interactive session (readline prompt, `/quit`, `/cancel`, `/stats`), one-shot `harness run "task"`, `harness doctor` (node version, model resolution, local endpoint reachability, limits).
- `src/pi/session.ts`: `createHarnessSession()` adapter — the only module importing Pi APIs. Normalized event stream (`NormalizedEvent`), subscribe/unsubscribe, prompt/abort/waitForIdle, stats, last-assistant-text, dispose.
- `src/config.ts`: validated config with precedence CLI → project `.harness/config.json` → defaults. Fixed a bug: `await import("node:fs")` inside a sync function (TS1308) — now a static import.
- Streaming output: text deltas to stdout, thinking in dim, tool start/end with status, errors to stderr.
- Cancellation: SIGINT aborts the current run (one-shot exits 130; interactive cancels and continues).

**Commands/checks and outcomes**
- `npm run typecheck` → clean
- `npm run build` → clean
- `harness doctor` → not yet smoke-tested against the live endpoint (pending)

**Commands/checks and outcomes**
- `npm run typecheck` → clean
- `npm run build` → clean
- `npm test` → 19/19 pass (tests/config.test.ts: 5 tests — defaults, project overrides, CLI overrides, undefined-clobber regression, invalid-config rejection; tests/events.test.ts: 14 tests — per-turn agent_end dropped, agent_settled→agent_end, text/thinking delta extraction, wrong-shape delta dropped, tool events, retry, compaction, unknown dropped)
- Real-model smoke test: PASSED (see M0 ticket 5 above)

**Known limitation / blocker**
- `harness resume`, `status`, `memory`, `skills`, `eval` commands not yet implemented (M2+).
- `maxToolCalls`/`maxTaskMinutes` limits are parsed and reported but not yet enforced by a controller (M2).
- Interactive mode not yet exercised against the live model (one-shot path is proven).

**Next action**
- M2: task controller (`src/task/`), state persistence with atomic writes, resume with workspace reconciliation.

## M8: real-model evidence — the learning loop closes (2026-10-17)

**Backend (user-mandated, no substitute models)**
- `local/qwen38` = Qwen3.8 27B UD-Q4_K_XL GGUF (27,320,697,856 params, `Q4_K - Medium`, 17.5 GB) served by the user's own `~/coder.sh --start` llama.cpp build on `http://127.0.0.1:8080/v1`, `n_ctx_slot = 65536`, one slot, Jinja Qwen template.
- An Ollama server + `qwen2.5-coder:7b` / `qwen3:8b` stand-in was installed earlier in the session while the real model was being located. It was stopped and is not used: no run in this repo was ever recorded against it, and `~/.pi/agent/models.json` keeps only `qwen38` for provider `local`.
- Tool calling verified directly: `POST /v1/chat/completions` with one `write` tool → `tool_calls[0].function = {"name":"write","arguments":"{\"path\":\"hi.txt\",\"content\":\"hi\"}"}`.

**Real runs (all `local/qwen38`, all recorded under `.harness/state/evals/`)**
| what | result |
| --- | --- |
| managed task `hello.txt` (2 tool calls) | `phase=completed`, check `test -f hello.txt` PASS |
| managed task "verify the gates" in repo root (2 tool calls) | `phase=completed`, `npm run typecheck && npm test` PASS |
| `eval run offbyone-fix` — skills arm | PASS, `tools=4`, `repairs=0`, 7.2 s, `changedPaths=["src/sum.ts"]` |
| `eval run offbyone-fix --no-skills` — baseline arm | PASS, `tools=4`, `repairs=0`, 8.7 s, `changedPaths=["src/sum.ts"]` |
| `skill propose` → `skill evaluate` → `skill approve` on the gate task | proposal → `PASS npm run typecheck && npm test` → promoted to `.harness/skills/verify-this-project-s-quality-gates-in-this-orde/SKILL.md` |
| `eval run offbyone-fix` again, after promotion | PASS, `tools=4`, `contextSkills=["verify-this-project-s-quality-gates-in-this-orde"]` — the learned skill is really injected |
| `eval score` | two arms reported separately, per-arm pass count and cost |

**Honest reading of the A/B result**
- Both arms pass with the same 4 tool calls. One scenario with one run per arm proves *injection and bookkeeping*, not yet that skills make the model better; that needs many runs per arm and harder scenarios. The scoreboard is the instrument for that, not the proof itself.
- Pre-backend runs remain in `history.jsonl` as `phase=failed`, `tools=0`. They are counted in `runs` and `passed` but excluded from cost statistics (see fix below).

**Bugs found only by running the real thing**
- Manifests carried no `changedPaths`; every run looked like it touched nothing. Now recorded from the task record (`[]` for no-change runs).
- `eval score` reported `best tools 0` because runs that never reached the backend record `0` tool calls; `Math.min` over them made a dead run look like a free perfect run. Cost stats (best/avg tools, best seconds) now cover only runs with `toolCalls > 0`, and print `—` when there are none.
- Skill titles were a hard `slice(0, 120)` of the goal, so the first promoted skill was titled `... Report both results. Do not`. `titleFromGoal` now takes the first sentence and cuts at a word boundary with an ellipsis (regression test in `tests/skills.test.ts`).

**Commands/checks and outcomes**
- `npm run typecheck` → clean; `npm run build` → clean; `npm test` → 79/79 pass.
- `harness doctor` → provider `local`, model `qwen38` resolved.
- Fixture integrity: `evals/fixtures/offbyone/src/sum.ts` still contains the bug (`i < n`); every fix landed in a run workspace.

**Next action**
- Grow the scenario set (2–3 more fixtures: multi-file refactor, failing-check repair, memory-dependent task) and run each arm N≥10 times to get pass rates with intervals. Only then is a skills-vs-baseline claim defensible.

## M9: packaged as `piharness`, with its own TUI (2026-10-17)

**Goal** — make this a thing the user can actually start (`piharness`), keep it
from colliding with the `pi` install already on the machine, and give it a
distinct look: black terminal, orange accent.

**Packaging**
- `package.json` declares `bin: { piharness, harness }` → `dist/cli.js`; the
  `piharness` command on this machine is a two-line `~/.local/bin` wrapper that
  execs `node /home/hati/code/piharness/dist/cli.js "$@"` (no `npm link`, no
  global prefix, survives rebuilds).
- `piharness --version` / `-v` prints `piharness 0.1.0`; `--help` documents the
  new command name and `--plain`.

**Isolation from `pi`** — `src/pi/agent-dir.ts`
- The harness uses `~/.config/piharness/agent` (override:
  `PIHARNESS_AGENT_DIR`) for `models.json`, `auth.json`, sessions and settings.
- On first run it copies **only** `models.json` from `~/.pi/agent` and never
  reads or writes `~/.pi` again. `~/.pi/agent/models.json` mtime is unchanged by
  harness runs; `pi --version` still reports 1.3.0.
- `piharness doctor` prints the agent dir and whether it was just seeded.

**TUI** — `src/ui/` (built directly on `@earendil-works/pi-tui` 1.3.0)
- `theme.ts` holds the palette and the only escape-code writers: bg `#0B0B0D`,
  surface `#17141A`, accent `#FF8A1F`, soft accent `#C26512`, text `#EDE6DC`,
  muted `#8B857C`, error `#FF5F56`. Truecolor; disabled when stdout is not a TTY
  or `NO_COLOR` is set.
- `blocks.ts` is a pure transcript renderer: user card with an orange rail, tool
  blocks with status bullets and collapsed output, streamed assistant text with
  a cursor, notices, plus the banner and the status footer. No terminal, no
  timers — which is why `tests/ui.test.ts` can assert real layout at real widths.
- `app.ts` owns the terminal: `TuiMainScreen`, `VStack`, `Editor`, streaming
  events from `HarnessSession`, a 500 ms elapsed-clock ticker, and Ctrl+C
  (cancel a running turn; second press within 1.5 s quits).
- Layout: banner printed once above the managed region, then transcript →
  status → editor, so the input box stays at the bottom of the screen.
- `--plain` (or a non-TTY stdout) falls back to the original line REPL.

**Bugs found by actually driving the TUI**
- Ctrl+C never reached an input listener: this TUI gives control keys to the
  focused component, so the interrupt is handled by overriding `Editor.handleInput`.
- `abort()` cancels the HTTP request but `agent_end` may never arrive (llama.cpp
  keeps decoding); the footer sat at "working" forever. The interrupt now ends
  the turn in the UI immediately and aborts in the background.
- Assistant text drew the rail glyph on every wrapped line; now only the first
  line gets the glyph and the last line gets the streaming cursor.
- The elapsed clock froze between events (0.0s forever) until a ticker was added.
- Sending `\r` before the TUI enables raw mode gets translated to `\n` by the tty
  and inserts a newline instead of submitting — a test harness gotcha, not a bug.

**Evidence (real model, `local/qwen38`)**
- TUI task: "Create a file named tui-check.txt containing the single word hello"
  → one `write` tool block, `ready · tools 1 · tokens 6462`, file content `hello`.
- Ctrl+C during a long generation → `· cancelled`, footer back to `ready` at 4.8 s.
- `/status`, `/help`, `/quit` verified through a pty; `--plain` verified on a pipe.

**Gates** — `npm run typecheck` clean, `npm run build` clean, `npm test` 89/89
(10 new TUI tests: palette contrast, SGR emission, width-exact padding, tool
collapse, transcript spacing, banner/status layout, arg/result summarisers).

**Not done** — no mouse, no scrollback paging (a long transcript is the
terminal's own scrollback), no syntax highlighting in tool output. The A/B
evidence gap from M8 is unchanged.

## M10: a benchmark that can say no (2026-10-17)

**Goal** — the M8 claim rested on one scenario and one run per arm. Grow the
scenario set, run each arm repeatedly, and report whatever comes out.

**What was added**
- `evals/scenarios/broken-export.json` + fixture: a re-export mismatch (`index.ts`
  asks for `formatCurrency`, `format.ts` exports `formatMoney`) plus a negative
  sign-formatting bug. The fixture's test is the contract; blast radius is `src/`.
- `evals/scenarios/parse-edge.json` + fixture: two edge cases in a list parser
  (empty input, empty segments).
- `evals/scenarios/gates.json` + fixture: `npm test` passes while the package's
  own build gate fails, so "run the tests and stop" is not enough.
- 36 + 12 runs: 6 skills, 6 baseline for each new scenario; the existing
  `offbyone-fix` already had 4 + 4 real runs from M8.

**Method** — identical fixtures, limits and model (`local/qwen38`); the arms
differ only in whether `.harness/skills` is copied into the run workspace. The
only approved skill at this point is the "run typecheck, then test" procedure
learned from `task-mvcoqoq7-vh5sbf`, so on these fixtures the skills arm is
mostly a *cost* measurement, not a capability one.

**Results (real runs only; `toolCalls > 0` or passed)**

| scenario | arm | n | pass | tools mean ± sd | mean secs |
| --- | --- | --- | --- | --- | --- |
| broken-export | skills | 6 | 6 | 5.5 ± 0.8 | 14.8 |
| broken-export | no-skills | 6 | 6 | 6.0 ± 1.3 | 13.6 |
| gates | skills | 6 | 6 | 7.7 ± 3.4 | 17.6 |
| gates | no-skills | 6 | 6 | 6.3 ± 2.2 | 11.5 |
| offbyone-fix | skills | 8 | 8 | 3.9 ± 0.6 | 9.4 |
| offbyone-fix | no-skills | 7 | 7 | 3.7 ± 0.5 | 8.6 |
| parse-edge | skills | 6 | 6 | 5.7 ± 1.0 | 12.8 |
| parse-edge | no-skills | 6 | 6 | 5.0 ± 0.6 | 11.7 |

Pooled: skills 26/26 passed, 5.54 ± 2.18 tools; baseline 25/25 passed,
5.20 ± 1.61 tools.

**The honest reading: the benchmark is saturated.** 51 of 51 real runs pass, in
both arms, on every scenario. A 27B model solves all four fixtures in 3–8 tool
calls, so there is no headroom for a skill to show up in the pass rate, and the
0.34-tool difference is far smaller than the spread within each arm (sd 1.6–2.2)
at n≈25. Any claim of the form "skills made the agent better" from this data
would be noise dressed up as evidence. What this does establish is that the
plumbing works: scenarios run, arms differ in exactly one input, failures are
recorded as failures, and `eval score` reports both arms separately.

**Also fixed**
- `eval score` divided by every recorded run, so two runs from before the local
  endpoint existed (0 tool calls, 28s of connect retries) made both arms look
  like 88%/89% pass. It now reports "passed N (X% of M that reached the model;
  K pre-backend)" and computes the rate over runs that passed or called a tool.
  The stale records stay in the append-only history — that is the point of it.

**Next action (real, not assumed)**
- To get a measurable A/B, the tasks have to be at or beyond the model's
  one-shot ability: multi-file refactors with a failing suite, long-horizon
  tasks where context management matters, or tasks whose *procedure* is
  non-obvious (release steps, migration order). Saturation at 51/51 says the
  current fixtures measure the harness, not the learning.
- Better still: keep the current set as a regression suite (it should stay at
  100%) and add a separate "hard" set where baseline pass rate is well below
  1.0 — a skill can only be shown to help where the baseline sometimes fails.

## M11: compaction, extensions, live stats (2026-10-17)

**Implemented behavior**

- `/compact [notes]` wraps Pi's `agentSession.compact()`; auto-compaction
  stays Pi's. `getContextUsage()` now remembers the last known token count so
  the footer does not blank out right after a manual compaction.
- Extension layer: harness-owned `HarnessTool` objects in `src/extensions/`,
  adapted to Pi in `src/pi/extensions.ts` (`registerTool` +
  `before_agent_start`). Built-ins: `todo` (persistent `.harness/todos.json`),
  `memory` (project `.harness/memory.json` + global `<agentDir>/memory.json`),
  `web_search`/`web_fetch` (DuckDuckGo HTML, SearXNG via
  `PIHARNESS_SEARCH_URL`, no API key), `outline`/`repo_map` (regex symbols,
  bounded scan, no LSP). Open todos and both memory scopes are injected into
  the system prompt every turn.
- TUI: footer meters for t/s, context window, GPU (sampled with `nvidia-smi`)
  and turn time; `/stats`, `/compact`, `/todos`, `/memory`, `/extensions`
  commands; `/extensions` reports Pi loader diagnostics.
- CLI: `piharness todo list|add|done|reopen|rm|clear`.
- Built-ins are attached to interactive and one-shot sessions only. Evaluation
  runs deliberately skip them so the recorded benchmark stays comparable.

**Checks and outcomes**

- `npm run typecheck`, `npm run build` — exit 0.
- `npm test` — 121 pass / 0 fail (29 new tests: todo store, DDG/SearXNG/page
  parsing with injected `fetch`, symbol outlines and repo-map bounds, stats
  formatters, status-line degradation, extension registry and context block,
  memory scopes and corrupt-file tolerance).
- Real model (`local/qwen38`), one-shot runs:
  - `todo` add → `.harness/todos.json` contains the item; a later session saw
    it in `todo list` without being told.
  - `memory` remember → `.harness/memory.json` contains the fact.
  - `web_search "node test runner api"` returned real URLs; `web_fetch` on
    `nodejs.org/api/test.html` returned the real title
    ("Test runner | Node.js v26.12.0 Documentation"); `repo_map` and
    `outline` returned the real files/symbols.
  - Eight `web_fetch` turns grew the session to `ctx 33k/66k 50%`;
    `/compact keep only the URLs fetched` reported `compacted: 33k → 23k
    tokens`.
- `piharness todo list|add` against a demo workspace reads and writes the same
  file the model uses.

**Known limitations**

- Compaction is refused by Pi below its threshold ("Nothing to compact
  (session too small)"). Observed: refused at 8.9k tokens, succeeded at 33k
  (also with `compaction.keepRecentTokens` lowered to 6000), so the gate is
  Pi's, not the harness's — the message is surfaced rather than forcing a
  summary.
- `/stats` right after a compaction used to blank the context meter (Pi reports
  `tokens: null` until the next request). `mergeContextUsage()` keeps the last
  estimate; covered by `tests/session-usage.test.ts`.
- Extension dirs that do not exist are filtered out before being handed to Pi,
  so `/extensions` no longer prints "Extension path does not exist" for the
  normal case of built-ins only.
- `outline`/`repo_map` are regex-based: they miss macros/dynamic definitions
  and are a complement to `grep`, not a replacement for an LSP.
- The GPU meter depends on `nvidia-smi`; without it the segment disappears.

**Next action**

- Build a hard eval set where the baseline sometimes fails, then measure
  whether the extension tools (not just skills) move the pass rate. The
  ranked options beyond that are in `docs/roadmap.md`.
