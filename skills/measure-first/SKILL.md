# Evidence before code: measure it, then trace it

Most wrong fixes come from reasoning about a system instead of reading it. Two
moves prevent that, and both cost one command.

## Measure the numbers

When the change depends on quantities — positions, sizes, timings, offsets,
counts — compute them first: `node -e 'console.log(2*7.9/0.4*3.3)'`,
`wc -l`, `grep -c`. Paste the value into your reasoning, not the formula. Never
read positions out of ASCII art, a screenshot or a long line by eye; index them
(`row.indexOf("F")`, `line.length`) and print the result. If a probe contradicts
your reasoning, the probe is right.

## Trace the run

Reproduce the failure in the smallest harness that still fails, and print the
state at the point of the decision — inputs, branch, compared values — not at the
point of the crash. Find the first moment a value is wrong; the cause is upstream
of the symptom. Change one thing, re-run the same probe, compare the same
numbers.

One trace harness, parameterized — not `_probe1.js`, `_probe2.js`, `_probe3.js`.
A file per hypothesis means each run tests a slightly different program, the
outputs stop being comparable, and the debris outlives the bug. Write one script
that takes the range to print and the scenario to simulate, then call it again
with different arguments.

## Harness fidelity

A harness that cannot reproduce the real environment is a random number
generator with a nice report. Before trusting a result, check that the harness
does what the runtime does:

- Event loops and timers run. A synchronous `for` loop cannot fire
  `setTimeout`, so code path that depends on it is silently never executed.
- Input events have order and duration. `keydown` immediately followed by
  `keyup` before the next frame is a state a real player cannot produce; hold a
  key across frames the way a hand does.
- Async work is awaited. A harness that reads a value before the promise
  resolves measures `undefined`, not the behaviour.

If the harness has to stub the runtime, write down what it stubs. A stubbed
timer or a clamped input is a place where a real bug can hide.

## Traps

- A test that cannot fail (no event loop, a timeout that never fires, an
  assertion on the wrong value) makes a green run meaningless: assert the
  outcome you care about, and print it.
- A value that stops changing may be inactive, clamped, cached or simply not
  updated. Print the flag before concluding anything about its behaviour.
- If you catch yourself re-deriving the same fact for the third time, that is the
  signal to run the command that answers it once.
- Two runs that disagree differ by inputs, cwd, env or cached state; diff the
  runs, not the code.
