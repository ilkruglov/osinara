/**
 * Per-step model usage audit log.
 *
 * Export:
 * - Eve hook that logs framework-reported usage of every completed model step with session identity.
 *
 * Key construct:
 * - Provider cache fields are logged separately at the transport boundary (`AGENT_MODEL_USAGE`);
 *   this hook adds the session, turn, and step so both logs can be correlated by order and time.
 */
import { defineHook } from "eve/hooks";

import { formatStepUsageLog } from "../lib/model-usage-log.js";

export default defineHook({
  events: {
    "step.completed"(event, ctx) {
      console.info(formatStepUsageLog(event, {
        channelKind: ctx.channel.kind,
        sessionId: ctx.session.id,
      }));
    },
  },
});
