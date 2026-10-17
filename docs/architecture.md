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
