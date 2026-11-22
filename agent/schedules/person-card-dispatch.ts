/**
 * Eve minute dispatcher for person cards.
 *
 * Export:
 * - Default schedule that queues due person cards and builds up to two at a time.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchPersonCards } from "../lib/person-cards/person-card-dispatcher.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(
      dispatchPersonCards().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            code: "AGENT_PERSON_CARD_SCHEDULE_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        throw error;
      }),
    );
  },
});
