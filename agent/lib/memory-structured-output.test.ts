/**
 * Memory structured-output provider boundary tests.
 *
 * Constructs covered:
 * - `createMemoryStructuredOutputGenerator`: one forced schema-bearing tool call without retries.
 * - Missing, duplicate, dynamic, wrong-name, and schema-invalid calls fail closed.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMemoryStructuredOutputGenerator } from "./memory-structured-output.js";

const schema = z.object({ decisions: z.array(z.string()) }).strict();
const request = {
  description: "Вернуть решения памяти",
  errorCode: "AGENT_MEMORY_TEST_OUTPUT_INVALID",
  errorMessage: "Провайдер вернул некорректное решение памяти",
  instructions: "Вызови инструмент один раз.",
  maxOutputTokens: 1_024,
  prompt: "Недоверенные тестовые данные",
  schema,
  timeout: 5_000,
  toolName: "submit_memory_test",
};

describe("memory structured output", () => {
  it("forces one schema-bearing tool call and returns its validated input", async () => {
    const generate = vi.fn().mockResolvedValue({
      toolCalls: [{
        dynamic: false,
        input: { decisions: ["save"] },
        toolName: request.toolName,
      }],
    });
    const generateStructured = createMemoryStructuredOutputGenerator({
      generate,
      model: { modelId: "memory-model" } as never,
    });

    await expect(generateStructured(request)).resolves.toEqual({ decisions: ["save"] });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: request.maxOutputTokens,
      maxRetries: 0,
      toolChoice: { toolName: request.toolName, type: "tool" },
    }));
    const options = generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("output");
    expect(options.tools).toHaveProperty(request.toolName);
  });

  it.each([
    ["missing", []],
    ["duplicate", [
      { dynamic: false, input: { decisions: ["save"] }, toolName: request.toolName },
      { dynamic: false, input: { decisions: ["skip"] }, toolName: request.toolName },
    ]],
    ["dynamic", [
      { dynamic: true, input: { decisions: ["save"] }, toolName: request.toolName },
    ]],
    ["wrong name", [
      { dynamic: false, input: { decisions: ["save"] }, toolName: "other_tool" },
    ]],
    ["invalid input", [
      { dynamic: false, input: { decisions: "save" }, toolName: request.toolName },
    ]],
  ])("rejects %s tool output", async (_case, toolCalls) => {
    const generateStructured = createMemoryStructuredOutputGenerator({
      generate: vi.fn().mockResolvedValue({ toolCalls }),
      model: {} as never,
    });

    await expect(generateStructured(request)).rejects.toThrowError(
      /AGENT_MEMORY_TEST_OUTPUT_INVALID/u,
    );
  });
});
