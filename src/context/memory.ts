/**
 * Memory: small verified facts about a project, stored as JSON and written
 * atomically. Two scopes share one format:
 *
 *   project — `<workspace>/.harness/memory.json` (gitignored, per repo)
 *   global  — `<agentDir>/memory.json` (follows the user across projects)
 *
 * Facts are data, never instructions to the agent.
 */

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "../fsutil.js";

export const MEMORY_SCHEMA_VERSION = 1;

export interface MemoryFact {
  /** Stable id, e.g. "fm2abc-x7k9p1" */
  id: string;
  /** One-line verified project fact. */
  fact: string;
  /** Lowercase tag words used for relevance matching. */
  tags: string[];
  /** "user" (stated by the user) or "verified" (observed by the harness). */
  source: "user" | "verified";
  /** ISO timestamp. */
  createdAt: string;
}

export interface Memory {
  version: 1;
  facts: MemoryFact[];
}

export class MemoryError extends Error {}

const MAX_FACT_LENGTH = 500;
const MAX_FACTS = 200;

export function memoryPath(workspace: string): string {
  return join(workspace, ".harness", "memory.json");
}

/** Global memory file, in the harness agent dir (survives every project). */
export function globalMemoryPath(agentDir: string): string {
  return join(agentDir, "memory.json");
}

/**
 * Load memory from an explicit file. Missing file → empty memory. Present but
 * invalid → MemoryError (never silently ignore a corrupt memory file).
 */
export function loadMemoryFile(path: string): Memory {
  if (!existsSync(path)) return { version: MEMORY_SCHEMA_VERSION, facts: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new MemoryError(`${path} has corrupt JSON: ${String(e)}; inspect it manually.`);
  }
  validateMemory(raw);
  return raw as Memory;
}

/** Load project memory (`<workspace>/.harness/memory.json`). */
export function loadMemory(workspace: string): Memory {
  return loadMemoryFile(memoryPath(workspace));
}

function validateMemory(raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MemoryError("memory.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== MEMORY_SCHEMA_VERSION) {
    throw new MemoryError(`memory.json version must be ${MEMORY_SCHEMA_VERSION}, got ${JSON.stringify(obj.version)}`);
  }
  if (!Array.isArray(obj.facts)) {
    throw new MemoryError("memory.json must have a facts array");
  }
  for (const f of obj.facts) {
    if (typeof f !== "object" || f === null) throw new MemoryError("each fact must be an object");
    const fact = f as Record<string, unknown>;
    if (typeof fact.id !== "string" || typeof fact.fact !== "string" || fact.fact.length === 0) {
      throw new MemoryError("each fact needs a string id and a non-empty fact");
    }
    if (!Array.isArray(fact.tags) || fact.tags.some((t) => typeof t !== "string")) {
      throw new MemoryError(`fact ${fact.id} tags must be an array of strings`);
    }
    if (fact.source !== "user" && fact.source !== "verified") {
      throw new MemoryError(`fact ${fact.id} source must be "user" or "verified"`);
    }
    if (typeof fact.createdAt !== "string") {
      throw new MemoryError(`fact ${fact.id} createdAt must be an ISO string`);
    }
  }
}

export function saveMemoryFile(path: string, memory: Memory): void {
  atomicWriteJson(path, memory);
}

export function saveMemory(workspace: string, memory: Memory): void {
  saveMemoryFile(memoryPath(workspace), memory);
}

function makeFactId(): string {
  // Random first so short id prefixes stay unambiguous.
  return `f${randomUUID().slice(0, 6)}`;
}

/** Add a fact to an explicit memory file and persist it. Returns the new fact. */
export function addFactToFile(
  path: string,
  fact: string,
  opts: { tags?: string[]; source?: "user" | "verified" } = {},
): MemoryFact {
  const trimmed = fact.trim();
  if (trimmed.length === 0) throw new MemoryError("fact text must be non-empty");
  if (trimmed.length > MAX_FACT_LENGTH) {
    throw new MemoryError(`fact is longer than ${MAX_FACT_LENGTH} characters`);
  }
  const memory = loadMemoryFile(path);
  if (memory.facts.length >= MAX_FACTS) {
    throw new MemoryError(`memory holds the max of ${MAX_FACTS} facts; remove some first`);
  }
  const newFact: MemoryFact = {
    id: makeFactId(),
    fact: trimmed,
    tags: (opts.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean),
    source: opts.source ?? "user",
    createdAt: new Date().toISOString(),
  };
  memory.facts.push(newFact);
  saveMemoryFile(path, memory);
  return newFact;
}

/** Add a fact to project memory and persist it. Returns the new fact. */
export function addFact(
  workspace: string,
  fact: string,
  opts: { tags?: string[]; source?: "user" | "verified" } = {},
): MemoryFact {
  return addFactToFile(memoryPath(workspace), fact, opts);
}

/** Remove a fact (by id, or by exact/unique-substring text) from a file. */
export function removeFactFromFile(path: string, idOrText: string): MemoryFact | undefined {
  const memory = loadMemoryFile(path);
  const needle = idOrText.trim();
  if (needle.length === 0) return undefined;
  let idx = memory.facts.findIndex((f) => f.id === needle);
  if (idx === -1) {
    const matches = memory.facts
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.fact.toLowerCase().includes(needle.toLowerCase()));
    if (matches.length !== 1) return undefined;
    idx = matches[0].i;
  }
  const [removed] = memory.facts.splice(idx, 1);
  if (memory.facts.length === 0) unlinkSync(path);
  else saveMemoryFile(path, memory);
  return removed;
}

/** Remove a fact by id from project memory. Returns true if one was removed. */
export function removeFact(workspace: string, id: string): boolean {
  return removeFactFromFile(memoryPath(workspace), id) !== undefined;
}

/** Facts whose text or tags contain the query (case-insensitive). */
export function searchFacts(memory: Memory, query: string): MemoryFact[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return memory.facts;
  const words = q.split(/\s+/).filter(Boolean);
  return memory.facts.filter((f) => {
    const haystack = `${f.fact} ${f.tags.join(" ")}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** Render facts as compact markdown bullets, newest last, capped. */
export function renderFacts(facts: MemoryFact[], limit = 20, maxChars = 1_200): string {
  const shown = facts.slice(-limit);
  const lines: string[] = [];
  let used = 0;
  for (const fact of shown) {
    const line = `- ${fact.fact}${fact.tags.length > 0 ? ` [${fact.tags.join(", ")}]` : ""}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
