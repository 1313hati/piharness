# piharness — Lean Pi Coding Harness

A coding agent that finishes verifiable tasks, remembers useful project facts, and gets better at recurring work without becoming a large platform.

Built as a single strict-TypeScript package around the pinned [Pi coding-agent SDK](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent@1.3.0`). Pi owns the agent loop, sessions, and transcripts; this app owns the workflow, memory, learning rules, config, and UX.

## Requirements

- Node.js >= 22.19.0
- A configured model backend (e.g. a local llama.cpp server registered in `~/.pi/agent/models.json`)

## Setup

```sh
npm install
npm run build
```

## Usage

```sh
# Interactive session
npx tsx src/cli.ts

# One-shot task
npx tsx src/cli.ts run "Fix the off-by-one bug in src/math.ts and run the tests"

# Managed task: persisted state, verification, bounded repair
npx tsx src/cli.ts task "Fix the off-by-one bug in src/sum.ts" --check "sum tests pass|npm test"
npx tsx src/cli.ts status        # active task, or all tasks
npx tsx src/cli.ts resume        # resume the active task

# Project memory (injected into task prompts)
npx tsx src/cli.ts memory add "Releases go out from main" --tag release
npx tsx src/cli.ts memory list

# Learning: propose → evaluate → approve
npx tsx src/cli.ts skill propose <taskId>
npx tsx src/cli.ts skill evaluate <name>
npx tsx src/cli.ts skill approve <name>

# Evaluation scenarios (evals/scenarios/) → .harness/state/evals/
npx tsx src/cli.ts eval list
npx tsx src/cli.ts eval run offbyone-fix
npx tsx src/cli.ts eval run --all
npx tsx src/cli.ts eval run offbyone-fix --dry-run   # validate only, no model
npx tsx src/cli.ts eval score                        # pass rate / cost across runs
npx tsx src/cli.ts eval run offbyone-fix --no-skills # baseline arm: no learned skills

# Diagnostics (node version, model resolution, local endpoint)
npx tsx src/cli.ts doctor

# Options
npx tsx src/cli.ts --provider local --model qwen38 --cwd /path/to/repo
```

After `npm link` (or adding `dist/` to PATH), the binary is `harness`.

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
src/task/             Task controller, state persistence, workspace lock, resume
src/context/          Memory facts, skill discovery, relevance selection, injection
src/skills/           Learning service: proposals, evaluation, promotion
src/eval/             Evaluation harness: scenarios, fixture runs, manifests
evals/                scenarios/ (what to run) and fixtures/ (what to run it on)
docs/architecture.md  Boundaries and decisions
docs/upstream.md      Exact Pi version and verified API assumptions
docs/progress.md      Current milestone, evidence, next action
```

## Status

See [docs/progress.md](docs/progress.md). M0–M8 are done with 79/79 tests and clean typecheck/build. The whole loop has run against the real local model (`local/qwen38`, Qwen3.8 27B UD-Q4_K_XL on llama.cpp): managed tasks complete with passing checks, both eval arms pass a scenario, and a skill learned from a completed task is proposed, evaluated, promoted and then observed in a later run's injected context. The A/B arm difference is not yet statistically meaningful (one run per arm) — see the M8 section for the honest reading.

## Trust model

v0.1 is for trusted repositories on the user's machine. The working directory is not a sandbox — shell commands can reach outside the workspace. External publishing, destructive changes, credential access, and package installs require explicit user authorization.
