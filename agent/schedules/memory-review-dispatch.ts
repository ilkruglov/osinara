/**
 * Eve minute dispatcher for durable silent memory-review batches.
 *
 * Export:
 * - Default schedule that claims ready 50-message batches and starts internal task sessions.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchPendingMemoryReviews } from "../lib/memory-review/memory-review-dispatcher.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(dispatchPendingMemoryReviews(to));
  },
});
