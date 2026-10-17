/**
 * Pi session adapter — the ONLY module that imports upstream Pi runtime APIs.
 *
 * This is the upgrade boundary: all other modules consume our normalized interfaces.
 * We do NOT run a second agent loop around Pi's internal loop.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureAgentDir } from "./agent-dir.js";
import { harnessInlineExtensions } from "./extensions.js";
import type { HarnessExtension } from "../extensions/types.js";

// ─── Normalized event types (our interface) ───────────────────────────────────

export type NormalizedEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; aborted: boolean }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_update"; toolName: string; toolCallId: string; partial: unknown }
  | {
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      result: unknown;
      isError: boolean;
      durationMs?: number;
    }
  | { type: "error"; message: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "message_start" }
  | { type: "message_end" };

export type NormalizedEventListener = (event: NormalizedEvent) => void;

// ─── Session handle ────────────────────────────────────────────────────────────

export interface HarnessSession {
  /** Send a prompt to the agent. Resolves when the agent finishes the turn. */
  prompt(text: string): Promise<void>;
  /** Abort the current operation and wait for idle. */
  abort(): Promise<void>;
  /** Wait for the agent to become idle. */
  waitForIdle(): Promise<void>;
  /** Whether the agent is currently processing. */
  get isStreaming(): boolean;
  /** Session ID for reference in task metadata. */
  get sessionId(): string;
  /** Session file path (Pi owns this). */
  get sessionFile(): string | undefined;
  /** Last assistant message text. */
  getLastAssistantText(): string | undefined;
  /** Get session statistics. */
  getSessionStats(): {
    toolCalls: number;
    tokens: { input: number; output: number; total: number };
  };
  /** Manually compact the conversation into a summary. */
  compact(customInstructions?: string): Promise<{ summary: string; tokensBefore: number; estimatedTokensAfter?: number }>;
  /** Context-window usage as Pi estimates it for the next request. */
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** Extension dirs/modules Pi loaded (built-ins are inline and unlisted). */
  getExtensionInfo(): { paths: string[]; diagnostics: string[] };
  /** Subscribe to normalized events. Returns unsubscribe function. */
  subscribe(listener: NormalizedEventListener): () => void;
  /** Clean up resources. */
  dispose(): void;
}

/**
 * Pi returns `tokens: null` right after a compaction (until the next request).
 * Falling back to the last estimate keeps the footer honest instead of
 * flashing "ctx ?/66k" for a whole turn.
 */
export function mergeContextUsage(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
  lastKnownTokens: number | undefined,
): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
  if (!usage) return undefined;
  if (typeof usage.tokens === "number") return usage;
  if (lastKnownTokens === undefined) return usage;
  const percent = usage.contextWindow > 0 ? (lastKnownTokens / usage.contextWindow) * 100 : null;
  return { tokens: lastKnownTokens, contextWindow: usage.contextWindow, percent };
}

// ─── Session creation ──────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  /** Working directory */
  cwd: string;
  /** Model provider id */
  provider: string;
  /** Model id */
  model: string;
  /** Thinking level */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Tool allowlist (default: read, bash, edit, write) */
  tools?: string[];
  /** Continue the most recent session */
  continueSession?: boolean;
  /** Harness-owned Pi agent dir (default: ~/.config/piharness/agent). */
  agentDir?: string;
  /** Harness extensions to expose as tools + per-turn context. */
  harnessExtensions?: HarnessExtension[];
  /** Extra directories to load Pi extension modules from (in addition to the defaults). */
  extensionPaths?: string[];
}

/** Built-in coding tools enabled by default. */
export const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Create a Pi agent session wrapped in our normalized interface.
 * This is the only place that calls createAgentSession().
 */
export async function createHarnessSession(
  opts: CreateSessionOptions,
): Promise<HarnessSession> {
  // Harness-owned agent dir: models.json seeded once from the pi install,
  // sessions and settings never shared with it.
  const agent = ensureAgentDir(opts.agentDir);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agent.dir, "auth.json"),
    modelsPath: agent.modelsPath,
    refreshOnCreate: false,
  });

  // Look up the model by provider/id
  const model = modelRuntime.getModel(opts.provider, opts.model);
  if (!model) {
    throw new Error(
      `Model ${opts.provider}/${opts.model} not found. ` +
      `Available providers: ${modelRuntime.getProviders().map((p) => p.id).join(", ")}`,
    );
  }

  // Extensions: our built-ins (inline factory) plus whatever the user drops in
  // `.harness/extensions/` or `<agentDir>/extensions/` as Pi extension modules.
  const inline = harnessInlineExtensions(opts.harnessExtensions ?? [], {
    cwd: opts.cwd,
    agentDir: agent.dir,
  });
  // Only hand Pi paths that exist: a missing dir is not a problem worth
  // printing, it just means the user relies on built-ins only.
  const extensionPaths = (opts.extensionPaths ?? [
    join(opts.cwd, ".harness", "extensions"),
    join(agent.dir, "extensions"),
  ]).filter((p) => existsSync(p));
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: agent.dir,
    extensionFactories: inline,
    additionalExtensionPaths: extensionPaths,
  });
  await resourceLoader.reload();

  const extensionToolNames = (opts.harnessExtensions ?? []).flatMap((e) => e.tools.map((t) => t.name));
  const result: CreateAgentSessionResult = await createAgentSession({
    cwd: opts.cwd,
    agentDir: agent.dir,
    model,
    modelRuntime,
    resourceLoader,
    thinkingLevel: (opts.thinkingLevel ?? "off") as any,
    tools: [...(opts.tools ?? DEFAULT_TOOLS), ...extensionToolNames],
  });

  const piSession: AgentSession = result.session;
  // Last context estimate we trust, so a compaction does not blank the meter.
  let lastKnownTokens: number | undefined;

  // Track our listeners
  const listeners = new Set<NormalizedEventListener>();

  // Single Pi listener that fans out to our normalized listeners
  const piListener: AgentSessionEventListener = (event: AgentSessionEvent) => {
    const normalized = normalizeEvent(event);
    if (normalized) {
      for (const l of listeners) {
        try {
          l(normalized);
        } catch {
          // Listener errors must not break the session
        }
      }
    }
  };
  piSession.subscribe(piListener);

  return {
    prompt(text: string): Promise<void> {
      return piSession.prompt(text, { expandPromptTemplates: false });
    },

    abort(): Promise<void> {
      return piSession.abort();
    },

    waitForIdle(): Promise<void> {
      return piSession.waitForIdle();
    },

    get isStreaming(): boolean {
      return piSession.isStreaming;
    },

    get sessionId(): string {
      return piSession.sessionId;
    },

    get sessionFile(): string | undefined {
      return piSession.sessionFile;
    },

    getLastAssistantText(): string | undefined {
      return piSession.getLastAssistantText();
    },

    getSessionStats() {
      const stats = piSession.getSessionStats();
      return {
        toolCalls: stats.toolCalls,
        tokens: {
          input: stats.tokens.input,
          output: stats.tokens.output,
          total: stats.tokens.total,
        },
      };
    },

    async compact(customInstructions?: string) {
      const res = await piSession.compact(customInstructions);
      // Pi reports `tokens: null` until the next request, which would make the
      // footer flash "ctx ?" right after a compaction. Keep the estimate.
      if (typeof res.estimatedTokensAfter === "number") lastKnownTokens = res.estimatedTokensAfter;
      return {
        summary: res.summary,
        tokensBefore: res.tokensBefore,
        estimatedTokensAfter: res.estimatedTokensAfter,
      };
    },

    getContextUsage() {
      const usage = piSession.getContextUsage();
      if (usage && typeof usage.tokens === "number") lastKnownTokens = usage.tokens;
      return mergeContextUsage(usage, lastKnownTokens);
    },

    getExtensionInfo() {
      const loaded = resourceLoader.getExtensions();
      return {
        paths: loaded.extensions.map((e) => e.path),
        diagnostics: [
          ...loaded.errors.map((e) => `${e.path}: ${e.error}`),
          ...(loaded.warnings ?? []).map((w) => `${w.path}: ${w.warning}`),
        ],
      };
    },

    subscribe(listener: NormalizedEventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): void {
      piSession.dispose();
      listeners.clear();
    },
  };
}

// ─── Event normalization ───────────────────────────────────────────────────────

/**
 * Translate a Pi AgentSessionEvent into our NormalizedEvent.
 * Returns null for events we don't need to surface.
 */
export function normalizeEvent(event: AgentSessionEvent): NormalizedEvent | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start" };

    case "agent_end":
      // agent_end fires per model turn (willRetry: boolean); agent_settled fires
      // once when the run fully settles. Surface only agent_settled as agent_end.
      return null;

    case "agent_settled":
      return { type: "agent_end", aborted: event.aborted };

    case "message_start":
      return { type: "message_start" };

    case "message_end":
      return { type: "message_end" };

    case "message_update": {
      // message_update carries { message, assistantMessageEvent };
      // assistantMessageEvent.type is text_delta | thinking_delta (with .delta)
      const ame = (event as any).assistantMessageEvent;
      if (
        ame &&
        (ame.type === "text_delta" || ame.type === "thinking_delta") &&
        typeof ame.delta === "string"
      ) {
        return ame.type === "thinking_delta"
          ? { type: "thinking_delta", text: ame.delta }
          : { type: "text_delta", text: ame.delta };
      }
      return null;
    }

    case "tool_execution_start":
      return {
        type: "tool_start",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      };

    case "tool_execution_update": {
      const e = event as any;
      return {
        type: "tool_update",
        toolName: e.toolName ?? "unknown",
        toolCallId: e.toolCallId ?? "",
        partial: e.partialResult,
      };
    }

    case "tool_execution_end": {
      const e = event as any;
      return {
        type: "tool_end",
        toolName: e.toolName ?? "unknown",
        toolCallId: e.toolCallId ?? "",
        result: e.result,
        ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
        isError: e.isError ?? false,
      };
    }

    case "compaction_start":
      return { type: "compaction_start" };

    case "compaction_end":
      return { type: "compaction_end" };

    case "auto_retry_start":
      return {
        type: "error",
        message: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
      };

    default:
      return null;
  }
}
