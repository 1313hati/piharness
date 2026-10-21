import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectStaleBuild, formatStaleBuild, newestMtime } from "../src/build-info.js";

/**
 * A checkout runs dist/, so a fix in src/ is invisible until `npm run build`.
 * That gap is what made a fixed transcript bug keep showing up days later, so
 * the guard has to be right in both directions: quiet on a fresh build, loud on
 * a stale one.
 */

function tree(entryMtime: number, srcMtimes: Record<string, number>) {
  const root = mkdtempSync(join(tmpdir(), "piharness-build-"));
  const dist = join(root, "dist");
  const src = join(root, "src");
  mkdirSync(dist, { recursive: true });
  const entry = join(dist, "cli.js");
  writeFileSync(entry, "// built\n");
  utimesSync(entry, new Date(entryMtime), new Date(entryMtime));
  for (const [rel, mtime] of Object.entries(srcMtimes)) {
    const path = join(src, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "// source\n");
    utimesSync(path, new Date(mtime), new Date(mtime));
  }
  return { root, entry, src };
}

const at = (iso: string) => Date.parse(iso);

test("newestMtime: finds the newest file, even nested", () => {
  const { src } = tree(at("2026-10-18T00:00:00Z"), {
    "cli.ts": at("2026-10-18T00:00:00Z"),
    "ui/blocks.ts": at("2026-10-18T03:00:00Z"),
    "ui/app.ts": at("2026-10-18T01:00:00Z"),
  });
  const newest = newestMtime(src);
  assert.ok(newest);
  assert.ok(newest.path.endsWith(join("ui", "blocks.ts")), newest.path);
  assert.equal(newest.mtimeMs, at("2026-10-18T03:00:00Z"));
});

test("newestMtime: a missing directory is not an error", () => {
  assert.equal(newestMtime(join(tmpdir(), "piharness-does-not-exist-xyz")), null);
});

test("stale build: src newer than dist is reported", () => {
  const { entry, src } = tree(at("2026-10-18T03:22:00Z"), {
    "cli.ts": at("2026-10-17T22:00:00Z"),
    "ui/blocks.ts": at("2026-10-18T12:14:00Z"),
  });
  const stale = detectStaleBuild(entry, src);
  assert.ok(stale, "a 9h-old build must be reported");
  assert.ok(stale.newest.endsWith(join("ui", "blocks.ts")));
  assert.equal(Math.round(stale.ageMs / 3_600_000), 9);
  const note = formatStaleBuild(stale);
  assert.match(note, /8\.9h older than src/);
  assert.match(note, /npm run build/);
});

test("fresh build: silent", () => {
  const { entry, src } = tree(at("2026-10-18T12:20:00Z"), {
    "ui/blocks.ts": at("2026-10-18T12:14:00Z"),
  });
  assert.equal(detectStaleBuild(entry, src), null);
});

test("installed package (no src/) and a missing entry are silent", () => {
  const { root, src } = tree(at("2026-10-18T12:20:00Z"), { "a.ts": at("2026-10-18T12:14:00Z") });
  assert.equal(detectStaleBuild(join(root, "dist", "cli.js"), join(root, "nope")), null);
  assert.equal(detectStaleBuild(join(root, "nope.js"), src), null);
});

test("sub-second differences do not warn (build just finished)", () => {
  const { entry, src } = tree(at("2026-10-18T12:20:00Z"), { "a.ts": at("2026-10-18T12:20:01Z") });
  assert.equal(detectStaleBuild(entry, src), null);
});
