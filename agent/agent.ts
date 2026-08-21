/**
 * Root Eve agent configuration.
 *
 * Constructs:
 * - Explicit primary model from the multi-provider registry.
 * - Fail-closed per-turn model step limit and NeuralDeep routing for upstream KV-cache reuse.
 * - Context compaction; Eve exposes its native fresh-context child only to root sessions.
 */
import { defineAgent, defineDynamic } from "eve";

import {
  AGENT_COMPACTION_THRESHOLD,
  AGENT_MAX_MODEL_STEPS_PER_TURN,
} from "./config.js";
import { primaryModel } from "./lib/model-registry.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";
import { resolveSessionModelSelection } from "./lib/neuraldeep-session-routing.js";
import { resolveTurnModelStepLimitSelection } from "./lib/turn-model-step-limit.js";

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
      "step.started": (event, ctx) => {
        // Resolve the guard first: resolver exceptions would let Eve silently use its fallback.
        const blockedSelection = resolveTurnModelStepLimitSelection({
          event,
          maxModelSteps: AGENT_MAX_MODEL_STEPS_PER_TURN,
          model: primaryModel,
        });
        if (blockedSelection !== null) return blockedSelection;

        return resolveSessionModelSelection({
          model: primaryModel,
          providerId: modelProviderConfig.provider,
          sessionId: ctx.session.id,
        });
      },
    },
  }),
  modelContextWindowTokens: primaryModelContextWindowTokens,
});
