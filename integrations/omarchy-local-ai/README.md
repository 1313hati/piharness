# Local AI panel integration (Omarchy `sero.local-ai`)

Three files in `~/.config/omarchy/plugins/sero.local-ai` are local additions; the
patch in `plugin.patch` recreates them after a plugin update overwrites the tree:

```bash
cd ~/.config/omarchy/plugins/sero.local-ai
git apply /path/to/integrations/omarchy-local-ai/plugin.patch
omarchy-restart-shell
```

- `bin/omarchy-local-ai-coder` (new): wraps `bin/omarchy-local-ai`. Its
  `snapshot` verb adds a `coder` block describing coder.sh's llama-server
  (detected by process args `qwen38` + `8080`, never by a hard-coded pid), and
  forwards every other verb to the real backend, including `run`, which is
  refused while coder.sh holds the GPUs.
- `Panel.qml`: its `cli` points at the wrapper, and `coder|<agent>` actions run
  `coder-<agent>` (which opens a terminal and launches that agent through
  `~/coder.sh`).
- `Model.js`: the home view gets a `CODER.SH · QWEN3.8 27B` section with the
  server state, context, **live token counters**, speed, and the agent buttons
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
