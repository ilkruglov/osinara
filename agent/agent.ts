/**
 * Root Eve agent configuration.
 *
 * Constructs:
 * - Explicit primary model from the multi-provider registry.
 * - Context compaction; Eve exposes its native fresh-context child only to root sessions.
 */
import { defineAgent } from "eve";

import { AGENT_COMPACTION_THRESHOLD } from "./config.js";
import { primaryModel } from "./lib/model-registry.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";

const primaryModelContextWindowTokens =
  modelProviderConfig.agent.models.primary.contextWindowTokens;

export default defineAgent({
  compaction: {
    modelContextWindowTokens: primaryModelContextWindowTokens,
    thresholdPercent: AGENT_COMPACTION_THRESHOLD,
  },
  model: primaryModel,
  modelContextWindowTokens: primaryModelContextWindowTokens,
});
