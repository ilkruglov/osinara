/**
 * Eve static minute dispatcher for application-managed proactive notifications.
 *
 * Export:
 * - Default minute schedule for reminders, expired-session retention, workspace cleanup, and
 *   cancellation of Telegram approvals nobody confirmed in time.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueReminders } from "../lib/reminders/reminder-dispatcher.js";
import { deleteExpiredSessions } from "../lib/sessions/session-retention.js";
import { sweepTimedOutApprovals } from "../lib/telegram-hitl/approval-timeout-sweep.js";
import { deleteOrphanedWorkspaces } from "../lib/workspaces/workspace-deletion.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(Promise.all([
      dispatchDueReminders(),
      deleteExpiredSessions(),
      deleteOrphanedWorkspaces(),
      sweepTimedOutApprovals(),
    ]));
  },
});
