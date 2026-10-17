/**
 * The harness extension contract.
 *
 * Deliberately free of Pi imports: extensions are plain objects that register
 * LLM-callable tools and contribute an optional per-turn context block. The
 * Pi adapter (`src/pi/extensions.ts`) turns these into Pi extension factories.
 */

import type { Static, TSchema } from "typebox";

export interface ToolResult {
  /** Text the model sees. */
  text: string;
  /** Report a failure without throwing; the model sees an error result. */
  isError?: boolean;
  /** Structured details for logs/UI; never sent to the model. */
  details?: unknown;
}

export interface ToolContext {
  /** Project root the tool operates on. */
  cwd: string;
  signal?: AbortSignal;
}

export interface HarnessTool<P extends TSchema = TSchema> {
  /** Tool name the model calls. Keep it short and verb-first. */
  name: string;
  /** Human-readable label for the transcript. */
  label: string;
  /** Description shown to the model. Say when to use it, not just what it does. */
  description: string;
  /** One line for the system prompt's tool list. */
  promptSnippet?: string;
  parameters: P;
  execute(params: Static<P>, ctx: ToolContext): Promise<ToolResult>;
}

export interface HarnessExtension {
  name: string;
  description: string;
  tools: HarnessTool<any>[];
  /**
   * Text appended to the system prompt before every turn. Re-read on each turn,
   * so edits to memory/todos show up without restarting the session.
   */
  context?: () => string;
}

/** Convenience for defining a tool with preserved parameter inference. */
export function defineTool<P extends TSchema>(tool: HarnessTool<P>): HarnessTool<P> {
  return tool;
}

/** Hard cap for any single tool result handed to a small model. */
export const MAX_TOOL_RESULT_CHARS = 24_000;

/** Truncate long tool output, telling the model what was cut. */
export function clampText(text: string, limit = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n… [truncated ${omitted} chars]`;
}
