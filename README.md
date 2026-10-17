# piharness — Lean Pi Coding Harness

A coding agent that finishes verifiable tasks, remembers useful project facts, and gets better at recurring work without becoming a large platform.

Built as a single strict-TypeScript package around the pinned [Pi coding-agent SDK](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent@1.3.0`). Pi owns the agent loop, sessions, and transcripts; this app owns the workflow, memory, learning rules, config, and UX.

## Requirements

- Node.js >= 22.19.0
- A model backend Pi can reach (e.g. a local llama.cpp server on `127.0.0.1:8080/v1`)

## Setup

```sh
npm install
npm run build
```

Then put the `piharness` command on your PATH. Either link the package:

```sh
npm link          # installs `piharness` and `harness`
```

or drop a two-line wrapper in `~/.local/bin` (what this machine uses):

```sh
cat > ~/.local/bin/piharness <<'SH'
#!/bin/sh
exec node /home/hati/code/piharness/dist/cli.js "$@"
SH
chmod +x ~/.local/bin/piharness
```

`harness` remains available as an alias of the same binary.

## Does this touch my `pi` install?

No. `pi` keeps its state in `~/.pi/agent`; piharness uses its own agent
directory, `~/.config/piharness/agent` (override with `PIHARNESS_AGENT_DIR`).
On first run it copies **only** `models.json` out of `~/.pi/agent` so the
provider list and endpoints come across, and never reads or writes `~/.pi`
again. Sessions, settings and any auth state the harness creates stay in the
harness directory, so the two front-ends cannot overwrite each other. Nothing
in `~/.pi` is modified — `pi` keeps working exactly as before.

## What the agent can do

- **Code navigation without an LSP** — `repo_map` (bounded file tree with top
  symbols), `outline` (symbols + line numbers for one file), plus `grep`.
- **Persistent todos** — `todo` keeps a task list in `.harness/todos.json`;
  open items are injected into the system prompt every turn, so a fresh
  session picks up where the last one stopped.
- **Persistent memory** — `memory` stores verified facts per project
  (`.harness/memory.json`) or globally (`<agentDir>/memory.json`). Facts are
  data, never instructions.
- **Web access without keys** — `web_search` (DuckDuckGo HTML, or SearXNG via
  `PIHARNESS_SEARCH_URL`) and `web_fetch` (page → clean text).
- **Compaction** — `/compact [notes]` summarizes the conversation when the
  context window fills; Pi's auto-compaction still runs on its own thresholds.
- **Live runtime stats** — the TUI footer shows generation speed (t/s),
  context usage (`ctx 8.2k/66k 12%`), GPU utilization/memory and turn time.

Tools are harness-owned objects (`src/extensions/`), registered with Pi through
one small adapter (`src/pi/extensions.ts`). Pi extension modules dropped into
`.harness/extensions/` or `<agentDir>/extensions/` load alongside them.

## Learning from your sessions

After a session that changed files and finished with a passing gate
(`npm test`, `npm run build`, `pytest`, …), the harness writes the evidence and
drafts a skill. When the same procedure shows up in a second, independent
session and the gate still passes, the draft is promoted into
`.harness/skills/` and injected into later prompts.

```
◇ learn: reinforced fix-the-failing-sum-test   (2/2 sessions needed before promotion)
★ learn: promoted   fix-the-failing-sum-test   — verified and promoted to .harness/skills/
```

- `/learn` inside the TUI, or `piharness learn [id]`, mines on demand.
- `piharness learn list` shows drafts, evidence counts and auto-promotions.
- Sessions that changed nothing, or whose gate failed, teach nothing.
- Turn it off with `PIHARNESS_NO_LEARN=1`; require more evidence with
  `PIHARNESS_MIN_EVIDENCE=3`; keep drafts manual with `PIHARNESS_AUTO_PROMOTE=0`.

## Usage

```sh
# Interactive TUI (black + orange), from any directory
piharness
piharness --cwd /path/to/repo
piharness --plain            # same session, plain line REPL (no TUI)

# One-shot task (no controller, no checks)
piharness run "Fix the off-by-one bug in src/math.ts and run the tests"

# Managed task: persisted state, verification, bounded repair
piharness task "Fix the off-by-one bug in src/sum.ts" --check "sum tests pass|npm test"
piharness status        # active task, or all tasks
piharness resume        # resume the active task

# Project memory (injected into task prompts)
piharness memory add "Releases go out from main" --tag release
piharness memory list

# Todos (persisted per repo)
piharness todo list
piharness todo add "write the migration"
piharness todo done <id>

# Learning: propose → evaluate → approve
piharness skill propose <taskId>
piharness skill evaluate <name>
piharness skill approve <name>

# Evaluation scenarios (evals/scenarios/) → .harness/state/evals/
piharness eval list
piharness eval run offbyone-fix
piharness eval run --all
piharness eval run offbyone-fix --dry-run   # validate only, no model
piharness eval score                        # pass rate / cost across runs
piharness eval run offbyone-fix --no-skills # baseline arm: no learned skills

# Diagnostics (node version, model resolution, local endpoint)
piharness doctor

# Options
piharness --provider local --model qwen38 --cwd /path/to/repo
```

The interactive TUI in one picture:

```
 █ PIHARNESS █                                            local/qwen38
  local agent harness · /home/hati/code/piharness

  ▌ you  fix the failing test in src/sum.ts

  ● edit  src/sum.ts
    │ ok
  │ The test expected 3 but sum() returned 2; fixed the off-by-one.
  ○ ready  ·  tools 4  ·  tokens 1832  ·  7.2s          /help  /quit
  ──────────────────────────────────────────────────────────────────────
  ❯ type a task… (Enter sends, Ctrl+C cancels, /quit exits)
  ──────────────────────────────────────────────────────────────────────
```

| Element | Color |
| --- | --- |
| Background | `#0B0B0D` (near-black) |
| User message card | `#17141A` with an orange rail |
| Accent (labels, bullets, spinner, wordmark) | `#FF8A1F` |
| Secondary accent (rails, soft glyphs) | `#C26512` |
| Text / muted | `#EDE6DC` / `#8B857C` |
| Errors | `#FF5F56` |

Colors are truecolor and drop automatically when stdout is not a TTY or
`NO_COLOR` is set. `/help`, `/status`, `/clear`, `/model`, `/quit` work in the
TUI; `--plain` gives the old line REPL for pipes and dumb terminals.

## Configuration

Precedence: CLI args → `.harness/config.json` (project) → defaults.

```json
{
  "provider": "local",
  "model": "qwen38",
  "maxToolCalls": 40,
  "maxTaskMinutes": 20,
  "commandTimeoutSec": 120,
  "maxRepairCycles": 2,
  "thinkingLevel": "off"
}
```

Secrets stay in environment variables or Pi's credential storage — never in project config.

## Layout

```
src/cli.ts            CLI entry points (run/task/resume/status/memory/skill/eval/doctor)
src/config.ts         Validated configuration and precedence
src/pi/session.ts     Pi session adapter — the ONLY module importing Pi APIs
src/pi/agent-dir.ts   Harness-owned Pi agent dir, isolated from ~/.pi
src/ui/               TUI: theme (black/orange), transcript blocks, app shell
src/task/             Task controller, state persistence, workspace lock, resume
src/context/          Memory facts, skill discovery, relevance selection, injection
src/skills/           Learning service: proposals, evaluation, promotion
src/eval/             Evaluation harness: scenarios, fixture runs, manifests
evals/                scenarios/ (what to run) and fixtures/ (what to run it on)
tests/                node:test suites, incl. ui.test.ts for the TUI renderers
docs/architecture.md  Boundaries and decisions
docs/upstream.md      Exact Pi version and verified API assumptions
docs/progress.md      Current milestone, evidence, next action
```

## Status

See [docs/progress.md](docs/progress.md) for what has been built and [docs/roadmap.md](docs/roadmap.md) for what is worth building next. M0–M11 are done with 121/121 tests and clean typecheck/build. The whole loop has run against the real local model (`local/qwen38`, Qwen3.8 27B UD-Q4_K_XL on llama.cpp): managed tasks complete with passing checks, both eval arms pass a scenario, and a skill learned from a completed task is proposed, evaluated, promoted and then observed in a later run's injected context. The A/B arm difference is not yet statistically meaningful (one run per arm) — see the M8 section for the honest reading. M9 adds packaging (`piharness` command, isolated agent dir) and the black/orange TUI; M10 grows the benchmark to four scenarios and twelve runs per arm — see the saturation caveat there. M11 adds compaction, the extension layer (persistent todos/memory, keyless web access, LSP-free code navigation) and live runtime statistics.

## Trust model

v0.1 is for trusted repositories on the user's machine. The working directory is not a sandbox — shell commands can reach outside the workspace. External publishing, destructive changes, credential access, and package installs require explicit user authorization.
