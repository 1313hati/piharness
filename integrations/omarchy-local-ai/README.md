# Local AI panel integration (Omarchy `sero.local-ai`)

Three files in `~/.config/omarchy/plugins/sero.local-ai` are local additions; the
patch in `plugin.patch` recreates them after a plugin update overwrites the tree:

```bash
cd ~/.config/omarchy/plugins/sero.local-ai
git apply /path/to/integrations/omarchy-local-ai/plugin.patch
omarchy-restart-shell
```

- `bin/omarchy-local-ai-coder` (new): wraps `bin/omarchy-local-ai`. Its
  `snapshot` verb adds a `coder` block for coder.sh (Qwen3.8 27B, alias
  `qwen38`) and a `codernew` block for codernew.sh (Swift 1.5 Qwen3.8 27B,
  alias `qwen38new`), each detected by process args `alias` + `8080`, never by
  a hard-coded pid, and forwards every other verb to the real backend,
  including `run`, which is refused while a coder server holds the GPUs. Both
  scripts listen on 8080: the wrapper stops the other one before a Start.
- `Panel.qml`: its `cli` points at the wrapper, and `coder|<agent>` /
  `codernew|<agent>` actions run `coder-<agent>` / `codernew-<agent>` (which
  open a terminal and launch that agent through the matching script).
- `Model.js`: the home view gets a `CODER.SH · QWEN3.8 27B` section and a
  `CODERNEW · SWIFT 1.5 27B` section, each with the server state, context,
  **live token counters**, speed, and the agent buttons
  `Start / Stop / Claude / Pi / piharness / Hermes / Logs`.

The token line is not the gateway's usage log (that never sees a native
llama-server). It comes from `/slots`:

| panel field | source |
|---|---|
| `tokens` | `n_prompt_tokens` in, `n_decoded` out (`next_token[0]`) |
| `speed` | Δ`n_decoded` / Δt between two snapshots, kept in `~/.local/state/coder/live.json`. With no second sample yet it falls back to `n_decoded` / time since the task started, so the first poll already shows a number; idle shows `idle · last N t/s`. The same string is the bar tooltip |
| `ctx` | `n_prompt_tokens + n_decoded` / `n_ctx` |
| `req` | count of distinct `id_task` values since the state file was created |

QML caches imported JavaScript for the life of the shell, so after editing
`Model.js` or `Panel.qml` run `omarchy-restart-shell` — a reboot is not needed.

The speed row is the fourth row of the home section (`⚡ speed`), and the Local AI
icon in the bar repeats it as a tooltip, so the number is readable without
opening the panel.

## The calendar grid

The home grid and its `N tokens · N requests` totals normally count gateway
requests only, so a llama-server started by `coder.sh` left it empty. The
wrapper now keeps its own per-day ledger in `~/.local/state/coder/usage.json`:

- every `snapshot` samples `/slots`; a task id seen for the first time adds its
  prompt tokens and one request, later samples add the output delta. This is
  server-side, so every client counts — piharness, Hermes, curl, anything.
- `merge_usage` folds those days into the snapshot's `life`/`total`, right
  aligned to today, and adds the request counts.
- `backfill-from-sessions.py` seeds history from piharness session logs
  (`input + cacheRead` in, `output` out, one request per assistant message),
  skipping sessions touched in the last 15 minutes so the live sampling is not
  double counted. Run it once:

```bash
python3 backfill-from-sessions.py
```

Prompt tokens include the cached prefix, which is why a coding session shows
millions: every turn re-processes the whole context on this server.
