/**
 * Model-facing tool boundary tests.
 *
 * Constructs covered:
 * - `wrapModelFacingTool`: preserves successful output and normalizes thrown failures.
 * - `wrapModelFacingToolMap`: applies the same boundary to a complete mode surface.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "./app-error.js";
import { wrapModelFacingTool, wrapModelFacingToolMap } from "./model-facing-tool.js";

function tool(execute: () => unknown) {
  return defineTool({
    description: "Test tool",
    inputSchema: z.object({}).strict(),
    execute,
  }) as ToolDefinition<any, any>;
}

describe("model-facing tool boundary", () => {
  it("preserves successful outputs and descriptor metadata", async () => {
    const source = tool(() => ({ ok: true }));
    const wrapped = wrapModelFacingTool("test_tool", source);

    await expect(wrapped.execute({}, {} as never)).resolves.toEqual({ ok: true });
    expect(wrapped.description).toContain(source.description);
    expect(wrapped.description).toContain("Ошибка:");
    expect(wrapped.inputSchema).toBe(source.inputSchema);
  });

  it("normalizes application and raw dependency errors for every mapped tool", async () => {
    const surface = wrapModelFacingToolMap({
      missing: tool(() => {
        throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись не найдена");
      }),
      raw: tool(() => {
        throw new Error("password=secret host=database");
      }),
    });

    await expect(surface.missing!.execute({}, {} as never)).rejects.toMatchObject({
      contract: { code: "AGENT_MEMORY_NOT_FOUND", retryable: true },
    });
    await expect(surface.raw!.execute({}, {} as never)).rejects.toMatchObject({
      contract: { code: "AGENT_TOOL_DEPENDENCY_FAILED", retryable: false },
    });
    await expect(surface.raw!.execute({}, {} as never)).rejects.not.toThrow(/secret/u);
  });
});
