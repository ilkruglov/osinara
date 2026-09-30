/** Provider boundary budget, including Eve retries. The agent loop remains Eve's. */
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Usage } from "@ai-sdk/provider";

// Eve treats the reserved ask_question name as a human-input boundary even after an override.
// Keep the public name at the model boundary; execute its fixture under a plain local tool name.
export const labToolRuntimeName = (name: string) => name === "ask_question" ? "skill_lab_ask_question" : name;
export const labToolPublicName = (name: string) => name === "skill_lab_ask_question" ? "ask_question" : name;
function renameToolPart<T extends object>(part: T, rename: (name: string) => string): T {
  return "toolName" in part && typeof part.toolName === "string" ? { ...part, toolName: rename(part.toolName) } : part;
}

/**
 * Output budget of one lab model call. DeepSeek counts reasoning in the output, and the lab runs
 * with production effort so a trial measures the real behaviour; at 2048 the reasoning alone used
 * the budget and a menu with a shopping list was cut off (30 September 2026: 11 of 16 runs
 * AGENT_MODEL_OUTPUT_TRUNCATED). The call count still bounds the cost.
 */
export const LAB_MAX_OUTPUT_TOKENS = 8192;
/** One lab model call, long enough for the budget above at production effort. */
export const LAB_CALL_TIMEOUT_MS = 120_000;
/** One whole run (process start, every call, the judge). */
export const LAB_RUN_TIMEOUT_MS = 240_000;

export function boundedLabModel(model: LanguageModelV4, reserve: () => void, usage: (u: LanguageModelV4Usage) => void, scenarioTools: readonly string[] = []): LanguageModelV4 {
  const allowed = new Set(["read_file", "write_file", "load_skill", ...scenarioTools]);
  const runtimeName = (name: string) => scenarioTools.includes("ask_question") ? labToolRuntimeName(name) : name;
  const prepare = (input: LanguageModelV4CallOptions): LanguageModelV4CallOptions => {
    if (JSON.stringify(input.prompt).length > 90_000) throw new Error("AGENT_SKILL_LAB_CONTEXT_LIMIT");
    reserve();
    const prompt = input.prompt.map((message) => typeof message.content === "string" ? message :
      { ...message, content: message.content.map((part) => renameToolPart(part, labToolPublicName)) }) as LanguageModelV4CallOptions["prompt"];
    return { ...input, prompt, maxOutputTokens: LAB_MAX_OUTPUT_TOKENS,
      tools: input.tools?.filter((t) => t.type === "function" && allowed.has(labToolPublicName(t.name))).map((t) => ({ ...t, name: labToolPublicName(t.name) })),
      toolChoice: input.toolChoice?.type === "tool" ? { ...input.toolChoice, toolName: labToolPublicName(input.toolChoice.toolName) } : input.toolChoice,
      abortSignal: AbortSignal.any([...(input.abortSignal ? [input.abortSignal] : []), AbortSignal.timeout(LAB_CALL_TIMEOUT_MS)]) };
  };
  return {
    specificationVersion: "v4", modelId: model.modelId, provider: model.provider, supportedUrls: model.supportedUrls,
    async doGenerate(input) { const result = await model.doGenerate(prepare(input)); usage(result.usage);
      return { ...result, content: result.content?.map((part) => renameToolPart(part, runtimeName)) }; },
    async doStream(input) {
      const result = await model.doStream(prepare(input));
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) { if (part.type === "finish") usage(part.usage); controller.enqueue(renameToolPart(part, runtimeName)); },
      })) };
    },
  };
}
