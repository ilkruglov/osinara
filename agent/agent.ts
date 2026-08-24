/**
 * Root Eve agent configuration.
 *
 * Constructs:
 * - Explicit primary model from the multi-provider registry.
 * - Step-scoped NeuralDeep session routing for upstream KV-cache reuse.
 * - Context compaction; Eve exposes its native fresh-context child only to root sessions.
 * - Official PostgreSQL Workflow world retained as an external runtime dependency.
 */
import { defineAgent, defineDynamic } from "eve";

import { AGENT_COMPACTION_THRESHOLD } from "./config.js";
import { primaryModel } from "./lib/model-registry.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";
import { resolveSessionModelSelection } from "./lib/neuraldeep-session-routing.js";

const primaryModelContextWindowTokens =
  modelProviderConfig.agent.models.primary.contextWindowTokens;

export default defineAgent({
  build: {
    externalDependencies: ["@workflow/world-postgres"],
  },
  compaction: {
    modelContextWindowTokens: primaryModelContextWindowTokens,
    thresholdPercent: AGENT_COMPACTION_THRESHOLD,
  },
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => resolveSessionModelSelection({
        model: primaryModel,
        modelContextWindowTokens: primaryModelContextWindowTokens,
        providerId: modelProviderConfig.provider,
        sessionId: ctx.session.id,
      }),
    },
  }),
});
