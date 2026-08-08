/**
 * Provider-enforced structured output for background memory model calls.
 *
 * Exports:
 * - `MemoryStructuredGenerate`: injectable AI SDK generation contract.
 * - `createMemoryStructuredOutputGenerator`: forces and validates one schema-bearing tool call.
 */
import { tool, type LanguageModel } from "ai";
import type { z } from "zod";

import { AppError } from "./app-error.js";

interface StructuredToolCall {
  dynamic?: boolean;
  input: unknown;
  toolName: string;
}

export interface MemoryStructuredGenerate {
  (options: Record<string, unknown>): Promise<{ toolCalls: readonly StructuredToolCall[] }>;
}

interface MemoryStructuredOutputRequest<Output> {
  description: string;
  errorCode: string;
  errorMessage: string;
  instructions: string;
  maxOutputTokens: number;
  prompt: string;
  schema: z.ZodType<Output>;
  timeout: number;
  toolName: string;
}

function invalidOutput(input: MemoryStructuredOutputRequest<unknown>): AppError {
  return new AppError(input.errorCode, input.errorMessage);
}

export function createMemoryStructuredOutputGenerator(dependencies: {
  generate: MemoryStructuredGenerate;
  model: LanguageModel;
}) {
  return async function generateStructured<Output>(
    input: MemoryStructuredOutputRequest<Output>,
  ): Promise<Output> {
    // DeepSeek does not support json_schema or forced tools while thinking. The dedicated memory
    // model disables thinking, allowing this named tool to carry the actual provider-side schema.
    const generated = await dependencies.generate({
      instructions: input.instructions,
      maxOutputTokens: input.maxOutputTokens,
      maxRetries: 0,
      model: dependencies.model,
      prompt: input.prompt,
      timeout: input.timeout,
      toolChoice: { toolName: input.toolName, type: "tool" },
      tools: {
        [input.toolName]: tool({
          description: input.description,
          inputSchema: input.schema,
        }),
      },
    });

    // Text output, extra calls, dynamic calls, and alternate tool names cannot become memory state.
    const call = generated.toolCalls[0];
    if (
      generated.toolCalls.length !== 1 ||
      !call ||
      call.dynamic === true ||
      call.toolName !== input.toolName
    ) {
      throw invalidOutput(input);
    }
    const parsed = input.schema.safeParse(call.input);
    if (!parsed.success) throw invalidOutput(input);
    return parsed.data;
  };
}
