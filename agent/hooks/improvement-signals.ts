/**
 * Improvement backlog signals.
 *
 * Export:
 * - Eve hook that turns a failed or heavy turn into reviewed backlog items for the owner.
 *
 * Key construct:
 * - Failures are logged, never thrown: a bookkeeping hook must not fail a Telegram turn.
 */
import { defineHook } from "eve/hooks";

import { improvementBacklogRepository } from "../lib/improvements/improvement-backlog-repository.js";
import { createImprovementSignalHandlers } from "../lib/improvements/improvement-signals.js";

const handlers = createImprovementSignalHandlers({
  record: (input) => improvementBacklogRepository.record(input),
});

function report(stage: string, error: unknown): void {
  console.error(JSON.stringify({
    code: "AGENT_IMPROVEMENT_SIGNAL_FAILED",
    error: error instanceof Error ? error.message : String(error),
    stage,
  }));
}

export default defineHook({
  events: {
    async "actions.requested"(event, ctx) {
      try {
        handlers.actionsRequested(event, ctx);
      } catch (error) {
        report("actions.requested", error);
      }
    },
    async "action.result"(event, ctx) {
      try {
        handlers.actionResult(event, ctx);
      } catch (error) {
        report("action.result", error);
      }
    },
    async "turn.completed"(event, ctx) {
      try {
        await handlers.turnCompleted(event, ctx);
      } catch (error) {
        report("turn.completed", error);
      }
    },
    async "turn.failed"(event, ctx) {
      try {
        await handlers.turnFailed(event, ctx);
      } catch (error) {
        report("turn.failed", error);
      }
    },
  },
});
