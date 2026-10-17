import assert from "node:assert/strict";
import { test } from "node:test";
import { renderStatus } from "../src/ui/blocks.js";
import { setColorEnabled } from "../src/ui/theme.js";
import { BLACK_ORANGE } from "../src/ui/theme.js";
import {
  StreamMeter, formatContext, formatDuration, formatGpu, formatRate, formatTokens,
} from "../src/ui/stats.js";
import { parseNvidiaSmi } from "../src/ui/gpu.js";

test("stats: StreamMeter estimates live, then prefers the exact rate", () => {
  const m = new StreamMeter();
  assert.equal(m.rate(1_000), null);

  m.delta("a".repeat(400), 1_000);
  m.delta("a".repeat(400), 2_000);
  // 800 chars ≈ 200 tokens over 1s
  assert.equal(Math.round(m.rate(2_000)!), 200);

  // Streamed text is the decode measurement; provider output tokens exclude
  // thinking, so they are only a fallback (see StreamMeter.rate).
  m.finish(42, 2_000);
  assert.equal(Math.round(m.rate(2_000)!), 200);

  const fallback = new StreamMeter();
  fallback.finish(42, 2_000);
  assert.equal(fallback.rate(2_000), 21);

  m.reset();
  assert.equal(m.rate(3_000), null);
});

test("stats: token/duration/rate formatting", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(812), "812");
  assert.equal(formatTokens(8_200), "8.2k");
  assert.equal(formatTokens(32_768), "33k");
  assert.equal(formatTokens(1_240_000), "1.2M");

  assert.equal(formatDuration(6100), "6.1s");
  assert.equal(formatDuration(92_000), "1m32s");
  assert.equal(formatDuration(3_600_000), "1h00m");

  assert.equal(formatRate(null), "");
  assert.equal(formatRate(0), "");
  assert.equal(formatRate(4.25), "4.3 t/s");
  assert.equal(formatRate(128.4), "128 t/s");
});

test("stats: context and gpu segments", () => {
  assert.equal(formatContext(null), "");
  assert.equal(formatContext({ tokens: null, contextWindow: 32_768, percent: null }), "ctx ?/33k");
  assert.equal(formatContext({ tokens: 8_200, contextWindow: 32_768, percent: 25.02 }), "ctx 8.2k/33k 25%");
  assert.equal(formatGpu(null), "");
  assert.equal(formatGpu({ utilPct: 87.4, memUsedMB: 21_913, memTotalMB: 24_576, gpus: 2 }), "gpu 87% 21.4/24.0G");
});

test("gpu: nvidia-smi parsing aggregates devices", () => {
  const single = parseNvidiaSmi("87, 21913, 24576, 61\n");
  assert.deepEqual(single, { utilPct: 87, memUsedMB: 21913, memTotalMB: 24576, tempC: 61, gpus: 1 });

  // two devices: peak utilization, summed memory
  const dual = parseNvidiaSmi("3, 11158, 12288, 41\n99, 12000, 12288, 70\n");
  assert.equal(dual?.utilPct, 99);
  assert.equal(dual?.memUsedMB, 23158);
  assert.equal(dual?.memTotalMB, 24576);
  assert.equal(dual?.gpus, 2);

  assert.equal(parseNvidiaSmi(""), null);
  assert.equal(parseNvidiaSmi("no devices"), null);
});

test("status line: meters show up when there is room and drop first when narrow", () => {
  setColorEnabled(false);
  const base = {
    busy: false,
    toolCalls: 3,
    tokens: 1234,
    elapsedMs: 6100,
    hint: "/help  /quit",
    rate: "12.3 t/s",
    context: "ctx 8.2k/33k 25%",
    gpu: "gpu 87% 21.4/24.0G",
  };
  const wide = renderStatus(base, 120, BLACK_ORANGE)[0];
  assert.match(wide, /gpu 87%/);
  assert.match(wide, /ctx 8\.2k/);
  assert.match(wide, /12\.3 t\/s/);
  assert.match(wide, /6\.1s/);

  const narrow = renderStatus(base, 60, BLACK_ORANGE)[0];
  assert.doesNotMatch(narrow, /gpu 87%/, "gpu is the first meter dropped");
  assert.match(narrow, /12\.3 t\/s/, "generation speed survives a narrow terminal");
  assert.match(narrow, /ready/);
  assert.match(narrow, /\/help/);

  // Even at 40 columns the rate stays: it is why the footer exists.
  const tiny = renderStatus(base, 40, BLACK_ORANGE)[0];
  assert.match(tiny, /t\/s/);
});
