/**
 * Pi session adapter — the ONLY module that imports upstream Pi runtime APIs.
 *
 * This is the upgrade boundary: all other modules consume our normalized interfaces.
 * We do NOT run a second agent loop around Pi's internal loop.
 */

import {
  createAgentSession,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";

// ─── Normalized event types (our interface) ───────────────────────────────────

export type NormalizedEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; aborted: boolean }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: unknown; isError: boolean }
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
  /** Subscribe to normalized events. Returns unsubscribe function. */
  subscribe(listener: NormalizedEventListener): () => void;
  /** Clean up resources. */
  dispose(): void;
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
}

/**
 * Create a Pi agent session wrapped in our normalized interface.
 * This is the only place that calls createAgentSession().
 */
export async function createHarnessSession(
  opts: CreateSessionOptions,
): Promise<HarnessSession> {
  // Create a model runtime that loads from the user's ~/.pi/agent/ config
  const modelRuntime = await ModelRuntime.create({
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

  const result: CreateAgentSessionResult = await createAgentSession({
    cwd: opts.cwd,
    model,
    modelRuntime,
    thinkingLevel: (opts.thinkingLevel ?? "off") as any,
    tools: opts.tools ?? ["read", "bash", "edit", "write"],
  });

  const piSession: AgentSession = result.session;

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

    case "tool_execution_end": {
      const e = event as any;
      return {
        type: "tool_end",
        toolName: e.toolName ?? "unknown",
        toolCallId: e.toolCallId ?? "",
        result: e.result,
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
