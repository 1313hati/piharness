import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { TranscriptBuilder, renderStatus, renderTranscript } from "../src/ui/blocks.js";
import { BLACK_ORANGE } from "../src/ui/theme.js";

/**
 * Screen-level regression for the bug that made a chat read as non-linear: a
 * block that changes above the viewport cannot be patched by a diff renderer,
 * so pi-tui falls back to a full clear (`ESC[2J` + `ESC[3J`) — scrollback gone,
 * repaint from the top, cursor bookkeeping lost. The transcript must therefore
 * be append-only, and these tests drive the real renderer into a real
 * TuiMainScreen to prove it, instead of trusting the block model.
 */

const COLS = 100;
const ROWS = 40;
const P = BLACK_ORANGE;
const strip = (s: string) =>
  s.replace(/\u001b_pi:[^\u0007]*\u0007/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

/** Just enough VT to know what the user would see. */
class Screen {
  lines: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
  row = 0;
  col = 0;
  clears = 0;
  wipes = 0;

  private scrollUp() {
    this.lines.shift();
    this.lines.push(Array(COLS).fill(" "));
  }
  private put(ch: string) {
    if (this.col >= COLS) {
      this.col = 0;
      this.row += 1;
      if (this.row >= ROWS) {
        this.scrollUp();
        this.row = ROWS - 1;
      }
    }
    this.lines[this.row][this.col] = ch;
    this.col += 1;
  }
  feed(data: string) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b") {
        const seq = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i));
        if (seq) {
          const [, params, cmd] = seq;
          const n = params && /^\d+$/.test(params) ? Number(params) : 0;
          if (cmd === "A") this.row = Math.max(0, this.row - (n || 1));
          else if (cmd === "B") this.row = Math.min(ROWS - 1, this.row + (n || 1));
          else if (cmd === "C") this.col = Math.min(COLS - 1, this.col + (n || 1));
          else if (cmd === "D") this.col = Math.max(0, this.col - (n || 1));
          else if (cmd === "G") this.col = Math.max(0, Math.min(COLS - 1, (n || 1) - 1));
          else if (cmd === "K") {
            const from = params === "2" ? 0 : this.col;
            for (let c = from; c < COLS; c++) this.lines[this.row][c] = " ";
          } else if (cmd === "J") {
            if (params === "2" || params === "3") {
              if (params === "2") this.clears++;
              else this.wipes++;
              this.lines = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
              this.row = 0;
              this.col = 0;
            } else {
              for (let r = this.row; r < ROWS; r++) {
                for (let c = r === this.row ? this.col : 0; c < COLS; c++) this.lines[r][c] = " ";
              }
            }
          } else if (cmd === "H" || cmd === "f") {
            this.row = 0;
            this.col = 0;
          }
          i += seq[0].length;
          continue;
        }
        const osc = /^\x1b\][^\x07]*\x07/.exec(data.slice(i));
        i += osc ? osc[0].length : 1;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.row++;
        if (this.row >= ROWS) {
          this.scrollUp();
          this.row = ROWS - 1;
        }
        i++;
        continue;
      }
      if (ch === "\x07") {
        i++;
        continue;
      }
      this.put(ch);
      i++;
    }
  }
  text() {
    return this.lines.map((r) => r.join("").trimEnd());
  }
}

class FakeTerminal {
  kittyProtocolActive = false;
  constructor(private readonly screen: Screen) {}
  get columns() {
    return COLS;
  }
  get rows() {
    return ROWS;
  }
  start() {}
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.screen.feed(data);
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

/** A transcript view + footer, driven exactly like the app drives them. */
function harness() {
  const screen = new Screen();
  const tui = new TuiMainScreen(new FakeTerminal(screen) as never);
  const builder = new TranscriptBuilder();
  const status = { busy: true, toolCalls: 0, tokens: 0, elapsedMs: 0, hint: "/help", rate: "12.0 t/s" };
  const component = {
    render: (width: number) => [
      ...renderTranscript(builder.blocks, width, P),
      ...renderStatus(status, width, P),
      "─".repeat(width),
      "❯ ".padEnd(width),
      "─".repeat(width),
    ],
    invalidate() {},
  };
  tui.addChild(component);
  tui.setClearOnShrink(false);
  tui.start();
  tui.renderNow();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = tui as any;
  return { screen, tui, builder, component, internals };
}

/** Frames until the buffer is several screens tall. */
function fill(h: ReturnType<typeof harness>, turns: number) {
  for (let t = 0; t < turns; t++) {
    h.builder.beginTurn();
    for (let i = 0; i < 4; i++) {
      h.builder.thinking(`thought ${t}.${i}: checking the file before the edit. `, COLS - 4);
      h.tui.renderNow();
    }
    h.builder.text(`answer ${t}: the file is fine. `);
    h.tui.renderNow();
    h.builder.append({ kind: "tool", name: "read", detail: `src/f${t}.ts`, status: "ok", output: ["ok"], truncated: false, ms: 80 });
    h.tui.renderNow();
    for (let i = 0; i < 6; i++) {
      h.builder.text(`sentence ${i} of the answer for turn ${t}, still streaming. `);
      h.tui.renderNow();
    }
    h.builder.end();
    h.tui.renderNow();
  }
}

test("screen: a long turn never clears the screen or the scrollback", () => {
  const h = harness();
  fill(h, 3);
  h.builder.beginTurn();
  for (let i = 0; i < 40; i++) {
    h.builder.thinking(`reasoning ${i}: the transcript is one unbounded component. `, COLS - 4);
    h.tui.renderNow();
  }
  for (let i = 0; i < 30; i++) {
    h.builder.text(`Sentence ${i} of the answer, streaming into the block below. `);
    h.tui.renderNow();
  }
  h.builder.append({ kind: "tool", name: "bash", detail: "npm test", status: "running", output: [], truncated: false });
  h.tui.renderNow();
  // The decisive frame: prose after a tool call. The old model kept appending
  // to the turn's first assistant block, which by now sits far above the
  // viewport — one changed line up there and the screen is cleared from row 0.
  for (let i = 0; i < 20; i++) {
    h.builder.text(`After the tool: line ${i} of the wrap-up. `);
    h.tui.renderNow();
  }
  h.builder.end();

  assert.equal(h.screen.clears, 0, "a full clear repaints from the top and looks like a jump");
  assert.equal(h.screen.wipes, 0, "ESC[3J destroys the scrollback: the conversation is gone");
});

test("screen: the bottom of the screen always shows the end of the transcript", () => {
  // The other half of the bug: pi-tui must not drift, or later frames paint on
  // rows that belong to earlier lines.
  const h = harness();
  fill(h, 2);
  const mismatches: string[] = [];
  const check = () => {
    const buffer = strip(h.component.render(COLS).join("\n")).split("\n");
    if (buffer.length < ROWS + 2) return;
    const shown = h.screen.text();
    for (let k = 1; k <= 2; k++) {
      const expected = buffer[buffer.length - k].trimEnd();
      const actual = shown[ROWS - k].trimEnd();
      if (expected !== actual) mismatches.push(`row ${ROWS - k}: expected "${expected}" got "${actual}"`);
    }
  };
  for (let i = 0; i < 25; i++) {
    h.builder.thinking(`reasoning ${i}: still working through it. `, COLS - 4);
    h.tui.renderNow();
    check();
  }
  assert.deepEqual(mismatches.slice(0, 3), []);
});

test("transcript: appending a tool never rewrites the lines above it", () => {
  // This is the exact old failure: the answer block was anchored above the
  // tool rows and every later delta rewrote it in place.
  const h = harness();
  fill(h, 2);
  h.builder.beginTurn();
  h.builder.text("Looking at the file first. ");
  const before = renderTranscript(h.builder.blocks, COLS, P);
  h.builder.append({ kind: "tool", name: "read", detail: "src/a.ts", status: "ok", output: [], truncated: false });
  h.builder.text("Done — the file is fine.");
  const after = renderTranscript(h.builder.blocks, COLS, P);

  // The only line allowed to change is the open segment's last line (the
  // streaming caret lives there); everything above it is immutable history.
  for (let i = 0; i < before.length - 1; i++) {
    assert.equal(after[i], before[i], `line ${i} was rewritten by an append`);
  }
  const plain = after.map((l) => strip(l));
  const at = (needle: string) => plain.findIndex((l) => l.includes(needle));
  // The visual claim, not just the index bookkeeping: the answer that came
  // after the call has to be printed after the call.
  assert.ok(at("Done — the file is fine.") > at("src/a.ts"), plain.join("\n"));
  assert.ok(strip(after[after.length - 1]).includes("Done — the file is fine."), strip(after[after.length - 1]));
});

test("transcript: a second thought run after a tool lands below it, not above", () => {
  const h = harness();
  h.builder.beginTurn();
  h.builder.thinking("first thought", 60);
  h.builder.append({ kind: "tool", name: "read", detail: "a.ts", status: "ok", output: [], truncated: false });
  h.builder.thinking("second thought", 60);
  h.builder.text("answer");
  const plain = renderTranscript(h.builder.blocks, 60, P).map((l) => strip(l));
  const at = (needle: string) => plain.findIndex((l) => l.includes(needle));
  assert.ok(at("first thought") < at("a.ts"), plain.join("|"));
  assert.ok(at("a.ts") < at("second thought"), plain.join("|"));
  assert.ok(at("second thought") < at("answer"), plain.join("|"));
});
