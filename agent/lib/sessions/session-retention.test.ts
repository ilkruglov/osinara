/**
 * Eve terminal session retention job tests.
 *
 * Constructs covered:
 * - A dedicated PostgreSQL advisory lock serializes physical Workflow graph deletion.
 * - A concurrent invocation exits without claiming a second application session.
 * - Destroying the lock connection releases the session-level lock after the sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => {
  let lockHeld = false;
  let resolveDeletion!: () => void;
  const deletionPromise = new Promise<void>((resolve) => {
    resolveDeletion = resolve;
  });
  const lockRelease = vi.fn((destroy?: boolean) => {
    if (destroy) lockHeld = false;
  });
  const lockQuery = vi.fn(async () => {
    if (lockHeld) return { rows: [{ acquired: false }] };
    lockHeld = true;
    return { rows: [{ acquired: true }] };
  });
  return {
    claimExpiredForDeletion: vi.fn(),
    completeDeletion: vi.fn(),
    connect: vi.fn(async () => ({ query: lockQuery, release: lockRelease })),
    deletePostgresEveSession: vi.fn(async () => deletionPromise),
    failDeletion: vi.fn(),
    lockQuery,
    lockRelease,
    resolveDeletion,
    retireAbandonedTasks: vi.fn(),
  };
});

vi.mock("../database.js", () => ({
  database: () => ({ connect: values.connect }),
}));
vi.mock("./workflow-run-retention.js", () => ({
  pruneConfiguredTerminalWorkflowRuns: vi.fn(async () => 0),
}));
vi.mock("./workflow-postgres-session-storage.js", () => ({
  deleteConfiguredPostgresEveSession: values.deletePostgresEveSession,
}));
vi.mock("./session-repository.js", () => ({
  sessionRepository: {
    claimExpiredForDeletion: values.claimExpiredForDeletion,
    completeDeletion: values.completeDeletion,
    failDeletion: values.failDeletion,
    retireAbandonedTasks: values.retireAbandonedTasks,
  },
}));

import { AppError } from "../app-error.js";
import { deleteExpiredSessions } from "./session-retention.js";

describe("deleteExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({
        eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR",
        id: "application-session-1",
        leaseToken: "lease-1",
      })
      .mockResolvedValue(null);
  });

  it("keeps sweeping past one failed session and closes a session whose storage is gone", async () => {
    values.claimExpiredForDeletion.mockReset()
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QA", id: "s-busy", leaseToken: "l-1" })
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QB", id: "s-gone", leaseToken: "l-2" })
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QC", id: "s-ok", leaseToken: "l-3" })
      .mockResolvedValue(null);
    values.deletePostgresEveSession
      .mockRejectedValueOnce(new AppError("AGENT_EVE_SESSION_STORAGE_ACTIVE", "ещё выполняется"))
      .mockRejectedValueOnce(new AppError("AGENT_EVE_SESSION_STORAGE_MISSING", "нет данных"))
      .mockResolvedValueOnce(undefined);

    await expect(deleteExpiredSessions()).resolves.toBe(2);

    expect(values.failDeletion).toHaveBeenCalledWith("s-busy", "l-1", "AGENT_EVE_SESSION_STORAGE_ACTIVE", expect.any(Date));
    expect(values.completeDeletion).toHaveBeenCalledWith("s-gone", "l-2");
    expect(values.completeDeletion).toHaveBeenCalledWith("s-ok", "l-3");
    expect(values.claimExpiredForDeletion).toHaveBeenCalledTimes(4);
  });

  it("serializes physical deletion across concurrent retention jobs", async () => {
    const first = deleteExpiredSessions();
    await vi.waitFor(() => expect(values.deletePostgresEveSession).toHaveBeenCalledTimes(1));

    await expect(deleteExpiredSessions()).resolves.toBe(0);
    expect(values.claimExpiredForDeletion).toHaveBeenCalledTimes(1);
    expect(values.lockRelease).toHaveBeenCalledWith(false);

    values.resolveDeletion();
    await expect(first).resolves.toBe(1);
    expect(values.completeDeletion).toHaveBeenCalledWith(
      "application-session-1",
      "lease-1",
    );
    expect(values.lockRelease).toHaveBeenLastCalledWith(true);
  });
});
