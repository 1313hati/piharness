/**
 * Piharness TUI theme — black background, orange accent.
 *
 * Everything the TUI paints goes through this file, so the look is a single
 * coherent choice rather than ad-hoc escape codes scattered through the app.
 * Colors are truecolor SGR written by hand: the terminal may not report
 * capabilities, and a wrong guess here shows up immediately as ugly output.
 *
 * Contrast rules we keep:
 *   - text on bg        >= 7:1  (#EDE6DC on #0B0B0D)
 *   - muted on bg       >= 4.5:1
 *   - accent on bg      >= 7:1  (#FF8A1F on #0B0B0D)
 */

import { visibleWidth } from "@earendil-works/pi-tui";

export interface Palette {
  /** Page background. Near-black, not pure black: pure #000 crushes the borders. */
  bg: string;
  /** Raised surfaces (user message card, input box). */
  surface: string;
  /** The accent. Orange, used for labels, bullets, borders, the prompt. */
  accent: string;
  /** Softer accent for large fills and secondary emphasis. */
  accentSoft: string;
  /** Primary text. */
  text: string;
  /** Secondary text, hints, metadata. */
  muted: string;
  /** Errors only. */
  error: string;
}

export const BLACK_ORANGE: Palette = {
  bg: "#0B0B0D",
  surface: "#17141A",
  accent: "#FF8A1F",
  accentSoft: "#C26512",
  text: "#EDE6DC",
  muted: "#8B857C",
  error: "#FF5F56",
};

/**
 * Color is a presentation concern; tests and piped output want plain text.
 * `maybeDisableForPipe()` is called once at startup.
 */
let colorEnabled = true;

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

/** Respect NO_COLOR (https://no-color.org) and non-TTY stdout. */
export function maybeDisableForPipe(isTty: boolean): void {
  if (process.env.NO_COLOR || process.env.TERM === "dumb" || !isTty) {
    colorEnabled = false;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function fg(hex: string, text: string): string {
  if (!colorEnabled) return text;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/**
 * Background paint. Uses SGR 49 to reset, so it nests under `fg()` without
 * cancelling it — a full-width row can carry its own background and still
 * contain colored text.
 */
export function bg(hex: string, text: string): string {
  if (!colorEnabled) return text;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

export function bold(text: string): string {
  return colorEnabled ? `\x1b[1m${text}\x1b[22m` : text;
}

export function dim(text: string): string {
  return colorEnabled ? `\x1b[2m${text}\x1b[22m` : text;
}

/**
 * Pad to the full row width and paint the background, so a card looks like a
 * card instead of a colored fragment floating on the terminal's own theme.
 * Width math goes through visibleWidth(): ANSI codes are zero-width and CJK
 * glyphs are two cells.
 */
export function padTo(text: string, width: number, background: string): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return bg(background, text + " ".repeat(pad));
}

export function repeat(char: string, width: number): string {
  return char.repeat(Math.max(0, width));
}
