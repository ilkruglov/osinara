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
    // Generic call discipline lives in the permanent instructions, not in every descriptor.
    expect(wrapped.description).toBe(source.description);
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

describe("model-facing approval boundary", () => {
  function approvalTool(approval: (ctx: unknown) => unknown) {
    return defineTool({
      approval: approval as never,
      description: "Approval tool",
      inputSchema: z.object({}).strict(),
      execute: () => ({ ok: true }),
    }) as ToolDefinition<any, any>;
  }
  const context = { toolInput: {}, toolName: "approval_tool" } as never;

  it("turns an application input error thrown by the approval policy into a denial", async () => {
    const wrapped = wrapModelFacingTool("approval_tool", approvalTool(() => {
      throw new AppError("AGENT_TEST_INPUT_INVALID", "Передайте toolAllowlist массивом");
    }));

    await expect((wrapped.approval as (ctx: unknown) => unknown)(context)).resolves.toEqual({
      reason: "AGENT_TEST_INPUT_INVALID: Передайте toolAllowlist массивом",
      type: "denied",
    });
  });

  it("passes ordinary approval decisions through unchanged", async () => {
    const wrapped = wrapModelFacingTool("approval_tool", approvalTool(() => "user-approval"));

    expect(await (wrapped.approval as (ctx: unknown) => unknown)(context)).toBe("user-approval");
  });

  it("does not swallow unexpected failures inside the approval policy", async () => {
    const wrapped = wrapModelFacingTool("approval_tool", approvalTool(() => {
      throw new TypeError("boom");
    }));

    await expect(async () => await (wrapped.approval as (ctx: unknown) => unknown)(context))
      .rejects.toThrow("boom");
  });

  it("keeps tools without an approval policy untouched", () => {
    const wrapped = wrapModelFacingTool("plain", tool(() => ({ ok: true })));

    expect(wrapped.approval).toBeUndefined();
  });
});
