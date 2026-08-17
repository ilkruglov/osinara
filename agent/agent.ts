/**
 * Root Eve agent configuration.
 *
 * Constructs:
 * - Explicit primary model from the multi-provider registry.
 * - Step-scoped NeuralDeep session routing for upstream KV-cache reuse.
 * - Context compaction; Eve exposes its native fresh-context child only to root sessions.
 */
import { defineAgent, defineDynamic } from "eve";

import { AGENT_COMPACTION_THRESHOLD } from "./config.js";
import { primaryModel } from "./lib/model-registry.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";
import { resolveSessionModelSelection } from "./lib/neuraldeep-session-routing.js";

const primaryModelContextWindowTokens =
  modelProviderConfig.agent.models.primary.contextWindowTokens;

export default defineAgent({
  compaction: {
    modelContextWindowTokens: primaryModelContextWindowTokens,
    thresholdPercent: AGENT_COMPACTION_THRESHOLD,
  },
  model: defineDynamic({
    fallback: primaryModel,
    events: {
      "step.started": (_event, ctx) => resolveSessionModelSelection({
        model: primaryModel,
        providerId: modelProviderConfig.provider,
        sessionId: ctx.session.id,
      }),
    },
  }),
  modelContextWindowTokens: primaryModelContextWindowTokens,
});
