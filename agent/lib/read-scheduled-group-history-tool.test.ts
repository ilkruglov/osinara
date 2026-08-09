/**
 * Run-bound scheduled group history reader tests.
 *
 * Constructs covered:
 * - The tool derives run identity only from verified scheduled auth.
 * - Opaque cursors are forwarded without model-selected group, dates, path, or limit.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readChunk = vi.hoisted(() => vi.fn());

vi.mock("./agent-schedules/scheduled-group-history-snapshot-repository.js", () => ({
  scheduledGroupHistorySnapshotRepository: { readChunk },
}));

import readScheduledGroupHistory from "./tools/read_scheduled_group_history.js";

function context(attributes: Record<string, unknown>): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes,
          authenticator: "telegram",
          principalId: "owner-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
  } as ToolContext;
}

describe("read_scheduled_group_history", () => {
  beforeEach(() => readChunk.mockReset());

  it("reads the initial chunk for the verified scheduled run", async () => {
    readChunk.mockResolvedValue({ done: false, nextCursor: "cursor-2", timeline: "timeline" });

    await readScheduledGroupHistory.execute({}, context({
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
    }));

    expect(readChunk).toHaveBeenCalledWith({ cursor: null, groupId: "group-1", runId: "run-1" });
  });

  it("rejects an ordinary external turn before repository access", async () => {
    await expect(readScheduledGroupHistory.execute({}, context({
      groupId: "group-1",
      groupType: "external",
    }))).rejects.toMatchObject({ code: "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED" });
    expect(readChunk).not.toHaveBeenCalled();
  });
});
