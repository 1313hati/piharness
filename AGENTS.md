# Agent instructions for building piharness

## On every implementation slice

1. Read this file, `docs/architecture.md`, and `docs/progress.md`.
2. Inspect the actual repository and exact dependency APIs (see `docs/upstream.md` for verified assumptions; recheck against installed `.d.ts` before using anything new).
3. State the acceptance check for the next small slice.
4. Implement the smallest end-to-end behavior.
5. Run focused checks, then required gates: `npm run typecheck && npm run build && npm test`.
6. Inspect the diff and remove unnecessary abstractions.
7. Update `docs/progress.md` with evidence (commands + outcomes) and the next concrete action.
8. Continue when unblocked; ask only about material product decisions.

## Hard rules

- **Only `src/pi/` may import `@earendil-works/pi-coding-agent`.** All other modules consume the normalized interfaces in `src/pi/session.ts`.
- **Do not fork Pi or recreate its agent loop.** Use the full coding-agent SDK (`createAgentSession`).
- **Preserve unrelated files and user changes.** Never blanket `git reset`/`git clean`.
- **No placeholders.** Build real functionality; if a backend/credential is missing, finish everything testable locally, report the precise remaining check, and never fabricate success.
- **No remote fallback.** Never silently send project data to a cloud provider.
- **Keep it lean:** one foreground agent, local JSON/Markdown, no web UI, no vector database, no multi-agent scheduler.
- **Milestone completion requires real evidence**, not mocks. Use mocks for failure paths; use a real local-model smoke test for integration.

## Progress entry format

- Milestone and task
- Implemented behavior
- Commands/checks and outcomes
- Known limitation or blocker
- Next action

## Gates

- `npm run typecheck` — strict TS, must pass
- `npm run build` — must pass
- `npm test` — focused tests for our boundaries (config, event normalization, task state)
- Real-model smoke test before claiming any integration milestone complete
