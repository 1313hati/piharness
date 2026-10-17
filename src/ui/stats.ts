/**
 * Live session meters for the TUI footer: generation speed, context usage,
 * token counts. Pure functions + one small state machine, so they are testable
 * without a terminal or a model.
 */

export interface ContextInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/**
 * Estimates generation speed from streamed text.
 *
 * Token counts are only exact after the model reports usage at the end of a
 * turn; while streaming we use the usual ~4 chars/token heuristic. The final
 * number for a turn comes from the session's token counters (see
 * `rateFromTokens`), so the footer does not lie once the turn is over.
 */
export class StreamMeter {
  private chars = 0;
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private finalRate: number | null = null;

  reset(): void {
    this.chars = 0;
    this.firstAt = null;
    this.lastAt = null;
    this.finalRate = null;
  }

  delta(text: string, now = Date.now()): void {
    if (text.length === 0) return;
    if (this.firstAt === null) this.firstAt = now;
    this.lastAt = now;
    this.chars += text.length;
    this.finalRate = null;
  }

  /** Record the exact rate for a finished turn (output tokens / seconds). */
  finish(outputTokens: number, elapsedMs: number): void {
    if (outputTokens > 0 && elapsedMs > 0) {
      this.finalRate = outputTokens / (elapsedMs / 1000);
    }
  }

  /**
   * Tokens/sec over the window where the model was actually emitting
   * (thinking + text). This is decode speed, so it excludes prompt
   * processing; the provider's `output_tokens` excludes thinking on reasoning
   * models, which made wall-clock math report absurdly low numbers for short
   * answers. `finish()` is only the fallback when no stream arrived.
   */
  /** Tokens streamed so far this turn (estimate; 4 chars ≈ 1 token). */
  tokens(): number {
    return this.chars / 4;
  }

  /** Milliseconds from turn start to the first streamed token, if seen. */
  ttftMs(startedAt: number): number | null {
    return this.firstAt === null ? null : Math.max(0, this.firstAt - startedAt);
  }

  /** When the last delta arrived, or null if nothing streamed yet. */
  lastActivityAt(): number | null {
    return this.lastAt;
  }

  rate(now = Date.now()): number | null {
    if (this.firstAt !== null && this.lastAt !== null) {
      const spanMs = Math.max(this.lastAt - this.firstAt, 250);
      return this.chars / 4 / (spanMs / 1000);
    }
    return this.finalRate;
  }

  get streamedChars(): number {
    return this.chars;
  }
}

/** 812 -> "812", 8200 -> "8.2k", 1_250_000 -> "1.2M" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 6100 -> "6.1s", 92000 -> "1m32s", 3_600_000 -> "1h00m" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** "12.3 t/s", or "" when there is no rate yet. */
/** Streamed tokens this turn, compact: 0 "", 412 "412", 2400 "2.4k". */
export function formatStreamTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  return tokens >= 1000 ? `+${(tokens / 1000).toFixed(1)}k tok` : `+${Math.round(tokens)} tok`;
}

/**
 * How long since the last event. Silence is the only honest signal that a
 * turn is stuck, so it is shown as soon as it starts to feel long.
 */
export function formatIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (!Number.isFinite(s) || s < 4) return "";
  return s >= 20 ? `stalled ${s}s` : `idle ${s}s`;
}

export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return "";
  return `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} t/s`;
}

/** "ctx 8.2k/32k 26%" — empty when the context size is unknown. */
export function formatContext(ctx: ContextInfo | null | undefined): string {
  if (!ctx || !ctx.contextWindow) return "";
  if (ctx.tokens === null || ctx.tokens === undefined) return `ctx ?/${formatTokens(ctx.contextWindow)}`;
  const pct = ctx.percent ?? (ctx.tokens / ctx.contextWindow) * 100;
  return `ctx ${formatTokens(ctx.tokens)}/${formatTokens(ctx.contextWindow)} ${Math.round(pct)}%`;
}

export interface GpuInfo {
  utilPct: number;
  memUsedMB: number;
  memTotalMB: number;
  tempC?: number;
  gpus: number;
}

/** "gpu 87% 21.4/24.0G" (aggregated over GPUs), empty when unavailable. */
export function formatGpu(gpu: GpuInfo | null | undefined): string {
  if (!gpu) return "";
  const mem = `${(gpu.memUsedMB / 1024).toFixed(1)}/${(gpu.memTotalMB / 1024).toFixed(1)}G`;
  return `gpu ${Math.round(gpu.utilPct)}% ${mem}`;
}
