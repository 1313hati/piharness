/**
 * Pi adapter for harness extensions: turns our plain tool/context objects into
 * one inline Pi extension factory.
 *
 * Pi calls `before_agent_start` before every turn, so memory and todos are
 * re-read each turn instead of frozen at session start — edit a todo or
 * remember a fact and the next turn already knows.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { renderHarnessContext } from "../extensions/builtin.js";
import { clampText, type HarnessExtension, type HarnessTool } from "../extensions/types.js";

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
        for (const tool of tools) {
          pi.registerTool(toPiTool(tool, deps));
        }
        pi.on("before_agent_start", (event) => {
          const blocks: string[] = [renderHarnessContext(deps)];
          for (const fn of contextFns) {
            try {
              const extra = fn();
              if (extra) blocks.push(extra);
            } catch {
              // a broken extension context must not kill the turn
            }
          }
          const extra = blocks.filter(Boolean).join("\n\n");
          if (!extra) return;
          return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
        });
      },
    },
  ];
}
