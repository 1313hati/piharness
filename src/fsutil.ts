/**
 * Small filesystem helpers shared across services (task store, memory,
 * skills, evals). Atomic write = write to temp file, then rename.
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomically write JSON to path (temp + rename). Creates parent dirs.
 */
export function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}
