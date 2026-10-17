# Roadmap: what to add next

Ordered by expected improvement per hour of work, not by novelty. Each item
names the check that would prove it worked — an idea without a test is not on
this list.

## 1. Checkpoints and `/undo` (high impact, ~half a day)

Before the agent touches files, snapshot the workspace into a shadow git repo
under `.harness/state/checkpoints/<turn>/` (or `git stash create` when the repo
already is git). `/undo` restores the last turn, `/diff` prints what changed.

Why: the harness already edits real repos with no recovery path. This is the
single biggest safety gain available.

Verify: a run that deletes a file, then `/undo`, must restore byte-identical
content (`git hash-object` before/after); `/diff` on a clean turn must be empty.

## 2. Diagnostics after edits (high impact, ~half a day)

A `check` tool that runs the project's own gate on the touched files only —
`tsc --noEmit` (or `--incremental` project), `pyright`, `cargo check`,
`ruff check` — and returns the first N diagnostics. The agent calls it after a
patch instead of guessing.

Why: `outline` tells the model where things are; diagnostics tell it whether
the change is right. Today only managed `task` runs get that feedback.

Verify: introduce a type error in a fixture, run one interactive turn, assert
the diagnostic line appears in the tool result and that the next turn fixes it.

## 3. Structured patch tool (high impact, ~2 hours)

`apply_patch` with a context-anchored hunk (like `git apply`), not full-file
`write`. On mismatch, return a precise "context not found at line X" error so
the model can re-read and retry.

Why: rewriting whole files wastes tokens and silently drops content on big
files, which is exactly where a 27B model degrades.

Verify: unit tests for hit/miss/ambiguous context; an eval scenario where the
file is larger than the model's comfortable output.

## 4. Session recall (medium impact, ~2 hours)

Index finished transcripts (`<agentDir>/sessions/*.jsonl`) into a small JSONL
index; `piharness recall "flaky test"` and a `recall` tool search it.

Why: memory stores small facts; the answer to "how did we fix this last week"
lives in transcripts that are currently write-only.

Verify: seed three sessions, assert query returns the right one and that a
tool call can cite the session id.

## 5. Prompt-cache accounting (medium impact, ~1 hour)

Keep the system prefix stable (guidelines → repo map → skills) and put volatile
text (todos, timestamps) last; show llama.cpp cache hits in `/stats` when the
server reports `timings.cache_n`.

Why: on a local 27B, input processing dominates latency; a cached prefix is
often a 2–3× wall-clock win. It only works if the prefix never changes order.

Verify: two consecutive turns with an unchanged prefix report `cache_n > 0`.

## 6. Shell permission policy (medium impact, ~2 hours)

Classify bash calls (read-only / writes / destructive) and require an explicit
`--allow` or an interactive confirmation for the last class; log every decision.

Why: the agent can currently `rm -rf` in the user's repo. This is cheap
insurance and makes unattended runs defensible.

Verify: a destructive command is refused without approval; the refusal is
visible to the model and it proposes a safer alternative.

## 7. Plan mode (medium impact, ~2 hours)

`/plan <goal>` runs a read-only turn (no edit/write/bash-mutate tools), writes a
plan to `.harness/state/plans/<id>.md`, then `/execute` runs it with the plan
pinned in context.

Why: separation improves outcomes for multi-file work and gives the user a
review point before anything changes.

Verify: plan-mode session produces a plan file and zero writes; execute turn
references the plan.

## 8. Delegation (optional, ~1 day)

`spawn_subagent` for read-only research in a child session, returning a summary.

Why: keeps the main context small on large repos.

Caveat: conflicts with the "one foreground agent, no scheduler" rule in
`AGENTS.md`. Only worth it if session-recall and compaction prove insufficient.

## Deliberately not on the list

Vector databases, a web UI, multi-agent schedulers, and cloud fallbacks. Every
one of them adds a moving part that the single-model, single-machine setup does
not need, and each would weaken the "we can explain every token" property.

## Near-term sequence

1. Checkpoints + `/undo` (safety first).
2. Structured patch + diagnostics (quality of edits).
3. Hard eval set where the baseline sometimes fails, then measure whether the
   extension tools move the pass rate — the current 51/51 benchmark cannot.
