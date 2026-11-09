/**
 * Shared fixtures of the owner health digest tests.
 *
 * Exports:
 * - `QUIET_OWNER_HEALTH_REPORT`: a day without failures, with memory counts.
 * - `stuckLanesReport`: a report with that many stuck lanes of long names, for digests past one
 *   Telegram message.
 * - `ownerHealthDigestDependencies`: the dispatcher's dependencies as mocks, two families by default.
 */
import { vi } from "vitest";

import type { createOwnerHealthDigestDispatcher } from "./owner-health-digest.js";
import type { OwnerHealthReport } from "./owner-health-digest-repository.js";
import { NO_SCHEDULE_RUN_FAILURES } from "./schedule-run-failures.js";

export const QUIET_OWNER_HEALTH_REPORT: OwnerHealthReport = {
  alertDeliveryFailures: 0,
  ingressFailures: { codes: [], count: 0 },
  lanes: { blocked: [], lagging: [] },
  memoryWritten: [
    { count: 3, kind: "episode", scope: "group" },
    { count: 1, kind: "profile", scope: "personal" },
  ],
  reviewBatches: { ambiguous: 0, failed: 0 },
  rotations: { count: 0, latestAt: null },
  scheduleFailures: NO_SCHEDULE_RUN_FAILURES,
  turnQuality: {
    delivered: 0,
    failed: 0,
    failedToolTurns: 0,
    followUps: { corrections: 0, repliesToMia: 0 },
    forbiddenTool: 0,
    heavy: 0,
    loops: 0,
    reactions: { negative: 0, other: 0, positive: 0 },
    repeatAfterError: 0,
    turns: 0,
    versions: [],
  },
  windowStart: new Date("2026-09-08T06:00:00.000Z"),
};

export function stuckLanesReport(count: number): OwnerHealthReport {
  return {
    ...QUIET_OWNER_HEALTH_REPORT,
    lanes: {
      blocked: Array.from({ length: count }, (_, index) => ({
        code: "AGENT_MEMORY_REVIEW_PASS_SKIPPED",
        headStatus: "failed",
        label: `Группа ${index} ${"с очень длинным названием ".repeat(4)}`,
        waiting: 40 + index,
      })),
      lagging: [],
    },
  };
}

export function ownerHealthDigestDependencies(
  overrides: Partial<Parameters<typeof createOwnerHealthDigestDispatcher>[0]> = {},
) {
  return {
    claim: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(undefined),
    balance: vi.fn().mockResolvedValue(null),
    deliver: vi.fn().mockResolvedValue(undefined),
    previousBalance: vi.fn().mockResolvedValue(null),
    storage: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([
      { familyId: "family-1", ownerTelegramUserId: "101" },
      { familyId: "family-2", ownerTelegramUserId: "202" },
    ]),
    release: vi.fn().mockResolvedValue(undefined),
    report: vi.fn().mockResolvedValue(QUIET_OWNER_HEALTH_REPORT),
    ...overrides,
  };
}
