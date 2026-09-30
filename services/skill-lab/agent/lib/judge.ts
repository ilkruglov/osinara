import { generateText } from "ai";
import { createConfiguredLanguageModel } from "../../../../agent/lib/model-transport.js";
import { boundedLabModel, LAB_CALL_TIMEOUT_MS, LAB_MAX_OUTPUT_TOKENS } from "../../../../agent/lib/authored-skills/skill-lab-model.js";
import { job, journal, reserveCall } from "./job.js";

export async function judge(prompt: string): Promise<string> {
  const config = job().model;
  const model = createConfiguredLanguageModel({ apiKey: process.env.MODEL_API_KEY ?? "", transport: config.transport,
    modelId: config.models.primary.id, maxOutputTokens: LAB_MAX_OUTPUT_TOKENS });
  const bounded = boundedLabModel(model, () => reserveCall("judge"), (usage) => journal({ kind: "usage", role: "judge", usage }));
  return (await generateText({ model: bounded, prompt, maxOutputTokens: LAB_MAX_OUTPUT_TOKENS, maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.max(1, Math.min(LAB_CALL_TIMEOUT_MS, (job().deadlineAt ?? Date.now()) - Date.now()))) })).text;
}
