import { generateText } from "ai";
import { createConfiguredLanguageModel } from "../../../../agent/lib/model-transport.js";
import { boundedLabModel } from "../../../../agent/lib/authored-skills/skill-lab-model.js";
import { job, journal, reserveCall } from "./job.js";

export async function judge(prompt: string): Promise<string> {
  const config = job().model;
  const model = createConfiguredLanguageModel({ apiKey: process.env.MODEL_API_KEY ?? "", transport: config.transport,
    modelId: config.models.primary.id, maxOutputTokens: 2048 });
  const bounded = boundedLabModel(model, () => reserveCall("judge"), (usage) => journal({ kind: "usage", role: "judge", usage }));
  return (await generateText({ model: bounded, prompt, maxOutputTokens: 2048, maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.max(1, Math.min(60_000, (job().deadlineAt ?? Date.now()) - Date.now()))) })).text;
}
