/**
 * Pi adapter for harness extensions: turns our plain tool/context objects into
 * one inline Pi extension factory.
 *
 * Pi calls `before_agent_start` before every turn, so memory and todos are
 * re-read each turn instead of frozen at session start — edit a todo or
 * remember a fact and the next turn already knows.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildSkillsBlock } from "../context/index.js";
import { FlailGuard, renderFlailNudge } from "../quality/flail.js";
import { ReadBeforeEdit, TurnGuard, renderVerifyNudge } from "../quality/verify.js";
import { buildRepoMap, invalidateCodeIndex, renderRepoMap } from "../extensions/code.js";
import { renderHarnessContext } from "../extensions/builtin.js";
import { environmentBlock } from "../context/environment.js";
import { detectProjectChecks } from "../context/project.js";
import { clampText, type HarnessExtension, type HarnessTool } from "../extensions/types.js";

/**
 * Standing engineering rules. Short on purpose: every token here is paid for
 * on each turn, so these are the behaviours that actually change output
 * quality on this model rather than general advice.
 */
const WORKING_RULES = [
  "## Working rules",
  "- Read a file before you edit it; never reconstruct it from memory.",
  "- Make the smallest change that satisfies the request; keep existing behaviour.",
  "- After changing code, run the project's test or build command and read the output before claiming success.",
  "- For a file longer than ~150 lines, write the first part, then append the rest with edit calls. One tool call that overruns the output budget is rejected and wastes the turn.",
  "- When a command fails, fix the cause the error names, not the symptom.",
  "- No placeholders, no TODO stubs, no \"rest of the implementation here\".",
  "- Before writing code that depends on numbers (positions, sizes, timing, physics), compute them with a one-line command and look at the result. If a probe contradicts your reasoning, the probe is right.",
  "- Work that needs more than a few tool calls starts with a todo list, and the list is updated as items finish. Do not hold a multi-step plan only in your head.",
  "- Report what the output showed, not what you hoped: quote the line that proves it, or say it is unverified. Never open with praise for your own work.",
].join("\n");

export interface InlineExtensionDeps {
  cwd: string;
  agentDir: string;
}

function toPiTool(tool: HarnessTool, deps: InlineExtensionDeps) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      const result = await tool.execute(params as never, { cwd: deps.cwd, signal });
      return {
        content: [{ type: "text" as const, text: clampText(result.text) }],
        details: (result.details ?? {}) as Record<string, unknown>,
        isError: result.isError ?? false,
      };
    },
  };
}

/** Build the inline extension that exposes every harness tool plus its context. */
export function harnessInlineExtensions(
  extensions: HarnessExtension[],
  deps: InlineExtensionDeps,
): InlineExtension[] {
  if (extensions.length === 0) return [];
  const tools = extensions.flatMap((e) => e.tools);
  const contextFns = extensions.map((e) => e.context).filter((fn): fn is () => string => typeof fn === "function");

  return [
    {
      name: "piharness",
      factory: (pi) => {
        // Probe the machine while the session is still starting, not on the
        // first turn: it costs ~300 ms of subprocesses and the user is already
        // watching a banner, not a blinking cursor.
        environmentBlock(deps.cwd);
        for (const tool of tools) {
          pi.registerTool(toPiTool(tool, deps));
        }
        // Watches the tool stream for loops (same file edited again and again,
        // the same call repeated, probes with no check) and says so before the
        // next turn. Deterministic: it counts, it does not judge.
        const flail = new FlailGuard();
        // Coding quality guards: count edits against checks, and refuse to edit
        // a file this session never saw. Both are deterministic; neither asks
        // the model to be more careful.
        const guard = new TurnGuard();
        const readGuard = new ReadBeforeEdit(deps.cwd);
        const projectChecks = detectProjectChecks(deps.cwd).commands;
        const callArgs = new Map<string, { name: string; args: unknown }>();
        const editsCode = new Set(["write", "edit", "patch", "apply_patch", "multiedit", "bash"]);
        pi.on("tool_execution_start", (event) => {
          flail.start(event.toolCallId, event.toolName, event.args);
          callArgs.set(event.toolCallId, { name: event.toolName, args: event.args });
          const input = event.args as Record<string, unknown> | undefined;
          const path = typeof input?.path === "string" ? input.path : undefined;
          if (event.toolName === "read" && path) readGuard.noteRead(path);
          if (event.toolName === "write" && path) readGuard.noteWrite(path);
          if (event.toolName === "bash" && typeof input?.command === "string") {
            readGuard.noteBash(input.command);
          }
        });

        // Editing a file from memory is the usual way content disappears from
        // it; one blocked call costs less than the corruption it prevents.
        pi.on("tool_call", (event) => {
          if (event.toolName !== "edit") return undefined;
          const input = event.input as Record<string, unknown> | undefined;
          const path = typeof input?.path === "string" ? input.path : undefined;
          if (!path) return undefined;
          const reason = readGuard.blockReason(path);
          return reason ? { block: true, reason } : undefined;
        });
        pi.on("tool_execution_end", (event) => {
          flail.end(event.toolCallId, event.isError);
          const rec = callArgs.get(event.toolCallId);
          if (rec) {
            callArgs.delete(event.toolCallId);
            guard.note({ name: rec.name, input: rec.args, failed: event.isError });
          }
          // A file changed: the symbol index is stale from this moment, and a
          // stale `code_find` is worse than no index at all.
          if (!event.isError && editsCode.has(event.toolName)) invalidateCodeIndex();
        });

        // The first turn of a session starts with the layout of the workspace
        // instead of five exploratory reads: file paths and their top symbols,
        // bounded hard so it cannot crowd out the transcript.
        let mapSeeded = false;

        // Mid-turn is where a loop actually happens: one user message can run
        // thirty tool calls. The `context` hook runs before every provider
        // request, so the correction arrives while it can still change the
        // next step, not after the turn has already ended.
        pi.on("context", (event) => {
          let nudge: ReturnType<FlailGuard["check"]> = null;
          try {
            nudge = flail.check();
          } catch {
            return undefined;
          }
          if (!nudge) return undefined;
          const text = renderFlailNudge(nudge);
          const tail = event.messages[event.messages.length - 1];
          if (tail && JSON.stringify(tail).includes("Stuck detection")) return undefined;
          const message = { role: "user", content: text, timestamp: Date.now() };
          return { messages: [...event.messages, message as (typeof event.messages)[number]] };
        });

        pi.on("before_agent_start", (event) => {
          guard.reset();
          const blocks: string[] = [renderHarnessContext(deps)];
          try {
            const nudge = flail.check();
            if (nudge) blocks.push(renderFlailNudge(nudge));
          } catch {
            // detection is advisory: never block a turn
          }
          if (!mapSeeded) {
            mapSeeded = true;
            try {
              const entries = buildRepoMap(deps.cwd, { maxFiles: 40, maxSymbolsPerFile: 4 });
              const code = entries.filter((e) => e.symbols.length > 0);
              if (code.length >= 2) {
                const map = renderRepoMap(code).slice(0, 6000);
                blocks.push(`### Workspace map (paths and top symbols; use code_find to locate more)\n${map}`);
              }
            } catch {
              // an unreadable workspace is not an error worth failing a turn over
            }
          }
          // Approved skills are matched against what the user actually asked
          // for, every turn: a skill learned in another project is only useful
          // if it can be reached from the TUI, not just from `piharness run`.
          const prompt = "prompt" in event && typeof event.prompt === "string" ? event.prompt : "";
          if (prompt.trim()) {
            try {
              const skills = buildSkillsBlock(deps.cwd, prompt);
              if (skills) blocks.push(skills);
            } catch {
              // skills are advisory: never fail the turn over them
            }
          }
          for (const fn of contextFns) {
            try {
              const extra = fn();
              if (extra) blocks.push(extra);
            } catch {
              // a broken extension context must not kill the turn
            }
          }
          const extra = [blocks.filter(Boolean).join("\n\n"), WORKING_RULES].filter(Boolean).join("\n\n");
          // Upstream's preamble says "inside pi"; this is its own front-end.
          const base = event.systemPrompt.replace("operating inside pi,", "operating inside piharness,");
          return { systemPrompt: `${base}\n\n${extra}` };
        });

        // The turn is about to end. If it changed code and never ran anything,
        // ending it here is how "done" comes to mean "I typed something". One
        // extra request, once per turn, with the evidence question asked.
        pi.on("agent_before_settle", (event) => {
          if (event.outcome !== "completed") return undefined;
          try {
            if (!guard.shouldNudge()) return undefined;
            guard.markNudged();
            const text = renderVerifyNudge(guard.editedFiles, guard.checkCommands, projectChecks);
            return {
              entries: [{ type: "custom_message", customType: "piharness-verify", content: text, display: true }],
              continue: true,
            };
          } catch {
            return undefined;
          }
        });
      },
    },
  ];
}
