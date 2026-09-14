/** Observe trusted root trial execution; no tool outputs or external group content are persisted. */
import { defineHook } from "eve/hooks";
import { skillEvaluationRepository } from "../lib/authored-skills/skill-evaluation-repository.js";
import { trustedChatKind } from "../lib/authored-skills/skill-signals.js";
import { isScheduledSession } from "../lib/agent-schedules/scheduled-session.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

export default defineHook({
  events: {
    async "action.result"(event, ctx) {
      if (ctx.channel.kind === "subagent" || isScheduledSession(ctx) || isMemoryReviewSession(ctx) || !trustedChatKind(ctx.session.auth)) return;
      const familyId = ctx.session.auth.current?.attributes.familyId;
      if (typeof familyId !== "string" || ctx.session.auth.current?.attributes.role !== "owner") return;
      const result = event.data.result;
      if (result.kind !== "tool-result") return;
      try {
        await skillEvaluationRepository.observe({
          familyId, eveSessionId: ctx.session.id, eveTurnId: event.data.turnId, eventId: event.meta.id,
          toolName: result.toolName, output: result.output, succeeded: event.data.status === "completed" && result.isError !== true,
        });
      } catch (error) {
        console.error(JSON.stringify({ code: "AGENT_SKILL_TRIAL_OBSERVATION_FAILED", error: error instanceof Error ? error.message : String(error) }));
      }
    },
  },
});
