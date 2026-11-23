/**
 * Transaction conflict retry tests.
 *
 * Coverage:
 * - A deadlock or serialization failure runs the transaction again, up to the attempts given; any
 *   other error and the last conflict reach the caller.
 */
import { describe, expect, it, vi } from "vitest";

import { retryOnTransactionConflict } from "./transaction-conflict-retry.js";

const conflict = (code: string) => Object.assign(new Error("conflict"), { code });

describe("retryOnTransactionConflict", () => {
  it("runs twice by default and gives up with the second conflict", async () => {
    const run = vi.fn().mockRejectedValue(conflict("40P01"));
    await expect(retryOnTransactionConflict(run)).rejects.toMatchObject({ code: "40P01" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  // Repeat review, 23 November 2026: an owner's group command met the same review turn's lock on
  // its retry and got PostgreSQL's raw deadlock.
  it("runs up to the attempts given", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(conflict("40P01"))
      .mockRejectedValueOnce(conflict("40001"))
      .mockResolvedValue("ok");
    await expect(retryOnTransactionConflict(run, 3)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not retry another error", async () => {
    const run = vi.fn().mockRejectedValue(conflict("23505"));
    await expect(retryOnTransactionConflict(run, 3)).rejects.toMatchObject({ code: "23505" });
    expect(run).toHaveBeenCalledOnce();
  });
});
