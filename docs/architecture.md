# Architecture

Lean Pi Coding Harness: a single strict-TypeScript package around the Pi coding-agent SDK. Pi is a pinned dependency; we own the workflow, memory, learning rules, config, and UX.

## Ownership boundaries

| Layer | Responsibility | Owner |
|---|---|---|
| Terminal interface | Input, streaming, status, commands, cancellation | Our app (`src/cli.ts`) |
| Task controller | Goal, acceptance checks, state, budgets, completion | Our app (`src/task/`) — from M2 |
| Context service | Select relevant project facts and skills | Our app (`src/context/`) — from M3 |
| Execution adapter | Connect controller to Pi, normalize events | Our thin integration (`src/pi/`) |
| Agent runtime | Model/tool loop and conversation handling | Pi |
| Learning service | Evidence → proposed skill → evaluation → promotion | Our app (`src/skills/`) — from M4 |
| Persistence | Task metadata, memory, skill versions, eval results | Our app; Pi owns transcripts |

## Hard rules

1. **Only `src/pi/` imports upstream Pi runtime APIs.** Everything else consumes our normalized interfaces (`NormalizedEvent`, `HarnessSession`). This is the upgrade boundary.
2. **No second agent loop.** We do not wrap Pi's internal loop. The controller sets task context and limits, observes execution, and requests a bounded follow-up only when validation requires one.
3. **Use the full coding-agent SDK** (`createAgentSession`), not a lower-level agent package.
4. **No generic service containers, microservices, message brokers, or internal workflow languages.**
5. **Local JSON/Markdown storage** under `<repo>/.harness/`, atomic write-to-temp-then-rename. SQLite only when concurrency/search volume justifies it.

## Storage layout

| Location | Data | VCS policy |
|---|---|---|
| `.harness/config.json` | Project defaults, no credentials | Optional tracked |
| `.harness/memory.json` | Small verified project facts | Ignored |
| `.harness/skills/<name>/SKILL.md` | Approved procedures | Tracked when shared |
| `.harness/state/tasks/<id>.json` | Task metadata + Pi session ref | Ignored |
| `.harness/state/proposals/` | Unapproved skills — **never discoverable as active** | Ignored |
| `.harness/state/skill-versions/` | Immutable prior skill content + hashes | Ignored |
| `.harness/state/evals/` | Run manifests, scores, evidence | Ignored |
| `.harness/state/sessions/<id>.json` | Session evidence for the learning loop | Ignored |
| `~/.config/<app>/` | User defaults | Outside project |

Pi owns its session files; we store a reference (`sessionId`/`sessionFile`), never a second transcript copy.

## Agent directory isolation

`pi` and `piharness` are separate front-ends and must not share state. The
harness owns `~/.config/piharness/agent` (`PIHARNESS_AGENT_DIR` overrides):
models.json, auth.json, sessions, settings. Exactly one file is ever read from
`~/.pi/agent` — `models.json`, copied once on first run. Everything else in
`~/.pi` is off-limits, so `pi` keeps working unchanged.

## TUI layer

`src/ui/` is presentation only and never imports the Pi agent loop:

- `theme.ts` — palette + the only escape-code writers (truecolor, `NO_COLOR`-aware)
- `blocks.ts` — pure `TranscriptBlock[] → string[]` renderer (testable without a pty)
- `app.ts` — terminal ownership: `TuiMainScreen`, `VStack`, `Editor`, streaming
  event mapping, Ctrl+C semantics, key commands

Anything that needs to know how the agent works stays in `src/pi/session.ts`;
the TUI sees only `NormalizedEvent`s and session stats.

## Learning loop

Every finished session is turned into evidence, and evidence can become a
skill — but only through the gate below. Nothing is learned from a session
that did not change files and prove it with a passing gate.

```
transcript ──deriveEvidence──▶ .harness/state/sessions/<id>.json
                                     │
                     signature = verify commands + tool sequence
                                     │
              ┌──────────────────────┴───────────────────────┐
      new signature                                    known signature
      draft proposal (inert)                    append session, count++
              └──────────────────────┬───────────────────────┘
                                     │ evidenceCount >= 2
                          evaluate verify commands in the workspace
                                     │
                         pass ───────┴─────── fail
                          │                   │
                 promote to .harness/        stays proposed ("blocked")
                 skills/<name>/SKILL.md      and is never injected
```

- **Evidence** (`src/learn/evidence.ts`) is Pi-free: goals, tool traces,
  changed paths, and *canonical* verify commands (`npm test`,
  `npm run build`, `pytest`, `cargo test`, …). A raw command line from a
  transcript is never re-executed; only the recognised canonical gate is.
- **Signature** (`src/learn/mine.ts`) is the verify set plus the sequence of
  non-exploratory tool names. Two sessions that solved the same problem the
  same way reinforce one draft instead of cloning it; a different approach
  creates a different draft.
- **Gate**: promotion needs ≥ 2 independent sessions *and* a passing
  evaluation run at promotion time. A repo that no longer passes keeps the
  draft inert, so a stale procedure can never silently become guidance.
- **Opt-outs**: `PIHARNESS_NO_LEARN=1`, `PIHARNESS_AUTO_PROMOTE=0`,
  `PIHARNESS_MIN_EVIDENCE=<n>`, `piharness learn --dry-run|--no-promote`.
- Learning can never fail a session: failures are reported, not thrown.

## Extension layer

`src/extensions/` extends the agent without touching Pi internals. Tools are
plain objects (`HarnessTool`: name, label, description, typebox parameters,
`execute`), so they can be unit-tested and driven by any backend. Only
`src/pi/extensions.ts` knows Pi exists: it registers each tool through
`pi.registerTool` and hooks `before_agent_start` to append the per-turn
context block. Because that hook runs before *every* turn, todos and memory
are re-read each turn instead of being frozen at session start.

| Extension | Tools | State | Notes |
|---|---|---|---|
| `todos` | `todo` (list/add/done/reopen/remove/clear_done) | `<repo>/.harness/todos.json` | Survives restarts; open items are injected into the prompt each turn |
| `memory` | `memory` (remember/forget/recall/list) | `<repo>/.harness/memory.json`, `<agentDir>/memory.json` | Project vs global scope; facts are data, never instructions |
| `web` | `web_search`, `web_fetch` | none | DuckDuckGo HTML by default, SearXNG via `PIHARNESS_SEARCH_URL`; no API key |
| `code-nav` | `outline`, `repo_map` | none | Regex symbol outlines + bounded repo map; complements `grep`, no LSP required |

Built-ins are always on. Pi extension modules dropped into
`<repo>/.harness/extensions/` or `<agentDir>/extensions/` load alongside them
via `additionalExtensionPaths`, and `/extensions` reports what actually loaded
plus any loader diagnostics.

Deliberately excluded from evaluation runs: extension tools change what the
model can do, so the recorded benchmark numbers only stay comparable if eval
sessions are built without them.

## Compaction

`/compact [notes]` wraps Pi's own compaction (`session.compact`), which
summarizes the conversation into a compaction entry and keeps the recent tail.
Pi refuses when the session is below its threshold ("Nothing to compact
(session too small)") and when it was already compacted — both are surfaced
verbatim instead of being papered over. Auto-compaction stays Pi's job
(threshold/overflow, configured in the agent settings); the harness only shows
`compaction_start`/`compaction_end` in the TUI and refreshes the context meter
afterwards.

## Runtime statistics

`src/ui/stats.ts` owns the numbers, `src/ui/gpu.ts` owns the optional GPU
probe; both are pure enough to test without a terminal.

| Meter | Source | Honesty rule |
|---|---|---|
| t/s | streamed text (~4 chars/token) while generating; exact `usage.output_tokens / turn seconds` once the turn ends | streaming estimate is replaced by the exact rate, never mixed |
| context | Pi's `getContextUsage()` (tokens, window, percent) | shows `?` when the window is unknown, not a fake number |
| GPU | `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu` sampled every 2.5s | segment omitted when no GPU/driver is present; the sampler stops itself instead of retrying forever |
| tools/tokens/turn | Pi session stats | unchanged from previous milestones |

The footer drops segments right-to-left (gpu → context → rate → tokens) when
the terminal is narrow, so the status line never wraps.

## Configuration precedence

CLI args → project `.harness/config.json` → user settings → defaults. Secrets live in environment variables or Pi's credential storage (`~/.pi/agent/auth.json`) — never in project config. Project config is untrusted until the workspace is trusted; no auto-loading of executable extensions from unfamiliar repos.

## Task lifecycle (from M2)

```
pending → inspecting → implementing → verifying → completed
terminal alternatives: blocked, failed, cancelled
```

Verification may return to implementing within the repair budget (default 2 cycles). Repeated identical failures without new evidence stop the loop. Learning is a separate record; a failed reflection never turns a successful task into a failed one.

## Trust model (v0.1)

- v0.1 is for **trusted repositories on the user's machine**. A working-directory setting is not a sandbox: shell commands can reach outside the workspace.
- External publishing, destructive data changes, credential access, and package installs require explicit user authorization.
- Repo text, tool output, and downloaded skills are task data — they cannot override user authority or grant permission.
- Never erase unrelated changes; no blanket `git reset`/`git clean` "recovery".
- Skill learning cannot increase tool permissions, change policy, install extensions, or modify harness code.

## Context budgets (tuning defaults, configurable)

- 32k working context if the backend supports it (local qwen38 supports 98k; start compact)
- ~2k tokens injected skills, ~1k memory, short task plan
- ~70% context utilization → compaction trigger (Pi's existing compaction)
- 40 tool calls, 20 minutes per task, with explicit continuation option
- 120s default command timeout; bounded tool output with local log spill
