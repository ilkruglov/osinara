/**
 * Eve ten-minute tick for the owner's daily health digest and the low-balance alert.
 *
 * Export:
 * - Default schedule; the dispatcher decides whether the day's digest is due and takes a claim.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchOwnerBalanceAlerts } from "../lib/health/owner-balance-alert.js";
import { dispatchOwnerHealthDigests } from "../lib/health/owner-health-digest.js";

export default defineSchedule({
  cron: "*/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchOwnerHealthDigests().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_OWNER_HEALTH_DIGEST_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
    // The balance alert runs on the same tick and never waits for the digest hour.
    waitUntil(dispatchOwnerBalanceAlerts().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_OWNER_BALANCE_ALERT_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
