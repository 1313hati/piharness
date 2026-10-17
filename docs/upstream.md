# Upstream Pi — verified API assumptions

Verified 2026-10-17 against the installed package. Recheck before any Pi upgrade.

## Pinned version

- `@earendil-works/pi-coding-agent@1.3.0` (exact pin in `package.json`, lockfile committed)
- Package `VERSION` export: `1.3.0`
- Upstream repo: `github.com/earendil-works/pi` (old `badlogic/pi-mono` redirects here)
- Node requirement: >= 22.19.0 (this machine runs Node v26.10.0)

## Verified exports (from package root)

- `createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>`
- `ModelRuntime.create({ refreshOnCreate?: boolean })` → `getProviders()`, `getModel(provider, id)`, `getModels(provider)`
- Also available but unused in v0.1: `createAgentSessionRuntime`, `createAgentSessionFromServices`, `createAgentSessionServices`, `SessionManager`, `DefaultResourceLoader`, tool factories (`createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`)

## Verified `CreateAgentSessionOptions` fields used

- `cwd?: string` — working directory for project-local discovery
- `modelRuntime?: ModelRuntime`
- `model?: Model<any>`
- `thinkingLevel?: ThinkingLevel`
- `tools?: string[]` — allowlist; `*` wildcard supported. When omitted, Pi uses default built-ins (read, bash, edit, write).

## Verified `AgentSession` members used

- `prompt(text, { expandPromptTemplates?: boolean, streamingBehavior?: "steer" | "followUp" }): Promise<void>`
- `abort(): Promise<void>`, `waitForIdle(): Promise<void>`
- `isStreaming: boolean`
- `sessionId: string`, `sessionFile: string | undefined`
- `getLastAssistantText(): string | undefined`
- `getSessionStats(): SessionStats` — `{ sessionFile, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens: { input, output, cacheRead, cacheWrite, total } }`
- `subscribe(listener: AgentSessionEventListener): () => void`
- `dispose(): void`

## Verified event shapes (from `@earendil-works/pi-agent-core` types)

- `agent_start`
- `agent_end` — fires **per model turn**, carries `{ messages, willRetry }`. NOT the run terminator.
- `agent_settled` — fires once when the run fully settles, carries `{ aborted }`. **This is the run terminator we surface as `agent_end`.**
- `message_update` — carries `{ message, assistantMessageEvent }` where `assistantMessageEvent.type` is one of `start | text_start | text_delta | text_end | thinking_start | thinking_delta | thinking_end | toolcall_delta | ...`; deltas live in `assistantMessageEvent.delta` (string).
- `tool_execution_start` — `{ toolCallId, toolName, args }`
- `tool_execution_end` — `{ toolCallId, toolName, result, isError }` (exact field names for result/isError read defensively at runtime)
- `compaction_start` / `compaction_end` — `{ reason: "manual" | "threshold" | "overflow", ... }`
- `auto_retry_start` — `{ attempt, maxAttempts, delayMs, errorMessage }`

## Local backend (this workstation)

- llama.cpp server at `http://127.0.0.1:8080/v1` (OpenAI-compatible completions API)
- Configured in `~/.pi/agent/models.json` under provider `local`, model `qwen38` (Qwen3.8 27B Q5, contextWindow 98304, maxTokens 8192, no reasoning)
- No API key required (`apiKey: "local"` placeholder); credentials never stored in project config
- `ModelRuntime.create({ refreshOnCreate: false })` picks up `~/.pi/agent/models.json` automatically — verified: provider `local` and model `qwen38` resolve

## Known quirks / unsupported

- `message_update` deltas are NOT top-level `event.delta`; they are nested under `assistantMessageEvent` (an early draft of the adapter assumed top-level — fixed).
- `agent_end` is per-turn, not per-run; treating it as run-end double-fires on multi-turn runs.
- llama.cpp backend reports only `completion` capability in `/v1/models`; tool-call format compatibility must be proven by the real-model smoke test (M0 ticket 5), not assumed.
