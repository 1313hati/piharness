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
src/cli.ts            Interactive/one-shot/doctor entry points
src/config.ts         Validated configuration and precedence
src/pi/session.ts     Pi session adapter — the ONLY module importing Pi APIs
docs/architecture.md  Boundaries and decisions
docs/upstream.md      Exact Pi version and verified API assumptions
docs/progress.md      Current milestone, evidence, next action
```

## Status

See [docs/progress.md](docs/progress.md). M0 (prove the base) done; M1 (useful agent) in progress.

## Trust model

v0.1 is for trusted repositories on the user's machine. The working directory is not a sandbox — shell commands can reach outside the workspace. External publishing, destructive changes, credential access, and package installs require explicit user authorization.
