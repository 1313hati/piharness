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

## M4: learning service — propose → evaluate → promote — CODE COMPLETE (2026-10-17)

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
- Bring the local endpoint up (`llama-server … --port 8080`), then run the real chain: `task … --check "…|npm test"` → `skill propose <taskId>` → `evaluate` → `approve` → second task that cites the injected skill. Record it here and flip this milestone to DONE.
- Then M5: evaluation harness — a repeatable scenario runner over `evals/` (copy fixture → run managed task → record pass/fail + budgets into `.harness/state/evals/`), so learning gains can be measured instead of asserted.

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
