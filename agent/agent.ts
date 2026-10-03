/**
 * Root Eve agent configuration.
 *
 * Constructs:
 * - Explicit primary model from the model registry.
 * - Fail-closed per-turn model step limit.
 * - Context compaction; Eve exposes its native fresh-context child only to root sessions.
 * - Official PostgreSQL Workflow world retained as an external runtime dependency.
 */
import { defineAgent, defineDynamic } from "eve";

import {
  AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS,
  AGENT_COMPACTION_THRESHOLD,
  AGENT_MAX_MODEL_STEPS_PER_TURN,
} from "./config.js";
import { isMemoryReviewSession } from "./lib/memory-review/memory-review-session.js";
import { memoryReviewModel, primaryModel } from "./lib/model-registry.js";
import { modelProviderConfig } from "./lib/model-provider-config.js";
import { resolveTurnModelStepLimitSelection } from "./lib/turn-model-step-limit.js";

// Eve derives the compaction threshold from the runtime-selected model's window, so the same
// capped value must reach both the static compaction config and the per-step model selection.
const primaryModelContextWindowTokens = Math.min(
  modelProviderConfig.agent.models.primary.contextWindowTokens,
  AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS,
);

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
      "step.started": (event, ctx) => {
        // Silent memory review runs the same model at its own reasoning effort.
        const model = isMemoryReviewSession(ctx) ? memoryReviewModel : primaryModel;
        // Resolve the guard first: resolver exceptions would let Eve silently use its fallback.
        const blockedSelection = resolveTurnModelStepLimitSelection({
          event,
          maxModelSteps: AGENT_MAX_MODEL_STEPS_PER_TURN,
          model,
          modelContextWindowTokens: primaryModelContextWindowTokens,
        });
        if (blockedSelection !== null) return blockedSelection;

        return { model, modelContextWindowTokens: primaryModelContextWindowTokens };
      },
    },
  }),
});
