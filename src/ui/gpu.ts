/**
 * GPU telemetry from `nvidia-smi`, sampled in the background.
 *
 * Deliberately optional: if the binary is missing, the driver is broken, or
 * there is no GPU, the sampler reports nothing and the TUI simply omits the
 * segment. Nothing here blocks the UI thread — samples land via callback.
 */

import { execFile } from "node:child_process";
import type { GpuInfo } from "./stats.js";

export type { GpuInfo };

const QUERY = "utilization.gpu,memory.used,memory.total,temperature.gpu";

export interface GpuSampleResult {
  gpus: Array<{ utilPct: number; memUsedMB: number; memTotalMB: number; tempC?: number }>;
}

/** Parse `nvidia-smi --format=csv,noheader,nounits` output (one line per GPU). */
export function parseNvidiaSmi(stdout: string): GpuInfo | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const gpus: GpuSampleResult["gpus"] = [];
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const utilPct = Number(parts[0]);
    const memUsedMB = Number(parts[1]);
    const memTotalMB = Number(parts[2]);
    if (![utilPct, memUsedMB, memTotalMB].every(Number.isFinite)) continue;
    const tempC = parts[3] !== undefined && Number.isFinite(Number(parts[3])) ? Number(parts[3]) : undefined;
    gpus.push({ utilPct, memUsedMB, memTotalMB, tempC });
  }
  if (gpus.length === 0) return null;
  return {
    // Peak utilization is the useful number (one busy GPU is a busy machine);
    // memory is summed, since llama.cpp splits a model across devices.
    utilPct: Math.max(...gpus.map((g) => g.utilPct)),
    memUsedMB: gpus.reduce((sum, g) => sum + g.memUsedMB, 0),
    memTotalMB: gpus.reduce((sum, g) => sum + g.memTotalMB, 0),
    tempC: Math.max(...gpus.map((g) => g.tempC ?? 0)) || undefined,
    gpus: gpus.length,
  };
}

type ExecFn = (file: string, args: string[], opts: { timeout: number }, cb: (err: Error | null, stdout: string) => void) => void;

const defaultExec: ExecFn = (file, args, opts, cb) => {
  execFile(file, args, { timeout: opts.timeout, maxBuffer: 64 * 1024 }, (err, stdout) => {
    cb(err, typeof stdout === "string" ? stdout : "");
  });
};

/** One sample, or null when there is no usable GPU. Never throws. */
export function sampleGpu(exec: ExecFn = defaultExec, timeoutMs = 1_200): Promise<GpuInfo | null> {
  return new Promise((resolve) => {
    try {
      exec("nvidia-smi", [`--query-gpu=${QUERY}`, "--format=csv,noheader,nounits"], { timeout: timeoutMs }, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(parseNvidiaSmi(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

export interface GpuSamplerOptions {
  intervalMs?: number;
  exec?: ExecFn;
  /** Called on every successful sample; not called when the GPU is unavailable. */
  onSample: (gpu: GpuInfo) => void;
  /** Stop after the first failure (no GPU present) to avoid scanning forever. */
  stopOnUnavailable?: boolean;
}

/** Start polling. Returns a stop function; also stops itself if no GPU is found. */
export function startGpuSampler(options: GpuSamplerOptions): () => void {
  const intervalMs = Math.max(500, options.intervalMs ?? 2_500);
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const gpu = await sampleGpu(options.exec);
    inFlight = false;
    if (stopped) return;
    if (gpu) options.onSample(gpu);
    else if (options.stopOnUnavailable !== false) stop();
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  void tick();
  return stop;
}
