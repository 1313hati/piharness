# Change the least that fixes the cause

Large rewrites feel productive and cost the user review time, regressions and
lost work. Correct behaviour is a small diff that names its reason.

## Procedure

1. Read the whole function or block before editing it, and the call sites that
   depend on it (`grep -rn "name(" src/`). Edit against the code that exists,
   not against a memory of it.
2. State the cause in one sentence, then make the smallest change that removes
   it. If you cannot state the cause, you are guessing — go and trace it first.
3. Keep the surrounding style: same quotes, same naming, same error handling,
   same comment density. Do not reformat, rename or reorder lines you did not
   need to touch.
4. Do not add an abstraction for one caller, a config flag nobody asked for, or
   an interface with a single implementation.
5. Re-read the diff before finishing. Every changed line should be explainable
   by the cause sentence. Unexplained lines get reverted.

## Hard limits

- No placeholders, no `TODO: implement`, no "rest of the implementation here".
  If a file is too large to write in one response, write a working part, run it,
  then append the next part with an edit.
- No new dependency when the standard library does it.
- No silent behaviour change: if the fix alters an API, a default, an output
  format or a file's shape, say so explicitly and update the call sites and
  tests in the same change.
- Deleting code that looks unused requires a grep first; if it is only referenced
  from a string or a config, it is not unused.

## The diff test

If the fix is correct, a reviewer can read the diff and agree without running
anything. If they would have to run it to find out what changed, the diff is too
wide.
