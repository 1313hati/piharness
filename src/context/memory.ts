/**
 * Project memory: small verified facts about this repository, stored at
 * `<workspace>/.harness/memory.json`. Local-only (gitignored), written
 * atomically. Facts are data, never instructions to the agent.
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

/**
 * Load project memory. Missing file → empty memory. Present but invalid →
 * MemoryError (never silently ignore a corrupt memory file).
 */
export function loadMemory(workspace: string): Memory {
  const p = memoryPath(workspace);
  if (!existsSync(p)) return { version: MEMORY_SCHEMA_VERSION, facts: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    throw new MemoryError(`${p} has corrupt JSON: ${String(e)}; inspect it manually.`);
  }
  validateMemory(raw);
  return raw as Memory;
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

export function saveMemory(workspace: string, memory: Memory): void {
  atomicWriteJson(memoryPath(workspace), memory);
}

function makeFactId(): string {
  return `f${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

/** Add a fact and persist. Returns the new fact. */
export function addFact(
  workspace: string,
  fact: string,
  opts: { tags?: string[]; source?: "user" | "verified" } = {},
): MemoryFact {
  const trimmed = fact.trim();
  if (trimmed.length === 0) throw new MemoryError("fact text must be non-empty");
  if (trimmed.length > MAX_FACT_LENGTH) {
    throw new MemoryError(`fact is longer than ${MAX_FACT_LENGTH} characters`);
  }
  const memory = loadMemory(workspace);
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
  saveMemory(workspace, memory);
  return newFact;
}

/** Remove a fact by id and persist. Returns true if a fact was removed. */
export function removeFact(workspace: string, id: string): boolean {
  const memory = loadMemory(workspace);
  const idx = memory.facts.findIndex((f) => f.id === id);
  if (idx === -1) return false;
  memory.facts.splice(idx, 1);
  if (memory.facts.length === 0) {
    unlinkSync(memoryPath(workspace));
  } else {
    saveMemory(workspace, memory);
  }
  return true;
}
