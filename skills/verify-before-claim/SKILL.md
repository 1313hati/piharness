# Prove the change before you describe it

A summary is not evidence. "This should work now" after an edit is the most
common way an agent loses trust: the user finds out at runtime. The rule is
narrow and absolute — a change is done when a command's output shows the
requested behaviour.

## Procedure

1. Before editing, write down the command that will prove the change
   (`npm test`, `npm run build`, `node --check x.js`, `curl -s localhost:8080/health`,
   the scenario script, the one-liner that reads the value back).
2. Make the change. Run that command. Read the whole output, not the exit code
   alone: a passing suite can hide a skipped test, and a build can warn about the
   thing you just wrote.
3. If the command cannot run (no server, no network, missing binary), say so and
   run the closest substitute that does run. Never invent the output, and never
   report a result you did not see.
4. In the final message, separate three things plainly:
   - **verified**: what a command output showed (quote it, briefly)
   - **changed**: files and the behaviour they now have
   - **unverified**: what still needs a human or a real device to confirm
5. Re-read the user's original request and check each clause against what you
   verified. "Fixed the parse error" does not answer "and also make it faster".

## A failing harness is a question first

When the thing that fails is your test harness, decide which side is wrong
before editing either. A bot that cannot land a stomp may be a bad bot, or a
collision rule that is too strict — but changing gameplay, an API contract or a
public behaviour so that a synthetic caller passes is the worst outcome: the
test goes green and the product is now wrong for real users.

Ask, in order: does the harness replay the real events (timing, order,
threading)? Is the assertion measuring what the user sees? Only then does the
product get touched, and then the change is described as a gameplay/behaviour
change, not as "test fix".

## Cheap habits that keep claims honest

- After editing a file, load it the way the app loads it (`node -e`, the actual
  entry point), not just through the type checker.
- After changing behaviour that a test covers, run that test by name first; if
  it passes but the suite fails, the suite is telling you something you skipped.
- When you cannot verify, the precise sentence is "I could not run X because Y",
  which is worth more than a confident guess.
