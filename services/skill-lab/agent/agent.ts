/** Separate native Eve application. No application DB, connections, channels or tools are inherited. */
import { defineAgent, defineDynamic } from "eve";
import { createConfiguredLanguageModel } from "../../../agent/lib/model-transport.js";
import { boundedLabModel } from "../../../agent/lib/authored-skills/skill-lab-model.js";
import { job, journal, reserveCall } from "./lib/job.js";

export default defineAgent({
  model: defineDynamic({ events: { "step.started": () => {
    const config = job().model;
    const model = createConfiguredLanguageModel({ apiKey: process.env.MODEL_API_KEY ?? "", transport: config.transport,
      modelId: config.models.primary.id, maxOutputTokens: 2048 });
    return { model: boundedLabModel(model, reserveCall, (usage) => journal({ kind: "usage", role: "agent", usage }), Object.keys(job().toolContracts ?? {})), modelContextWindowTokens: 100_000 };
  } } }),
});
