/**
 * Exactly-once Lavka side effects over an in-memory ledger.
 *
 * Constructs covered:
 * - The first call runs and stores its result; a replay of the same call returns it without
 *   touching Lavka again.
 * - A replay of a call whose first attempt never finished is ambiguous (cart or order wording).
 * - A different input under the same key is refused.
 * - A definitive refusal frees the key, an unknown failure keeps it.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { runLavkaOperation, type LavkaOperationRepository } from "./lavka-operation.js";

function ledger(): LavkaOperationRepository & { rows: Map<string, { requestHash: string; result: unknown; status: "completed" | "started" }> } {
  const rows = new Map<string, { requestHash: string; result: unknown; status: "completed" | "started" }>();
  return {
    rows,
    async begin(input) {
      const key = `${input.userId}:${input.key}`;
      const row = rows.get(key);
      if (row) return { kind: "existing", ...row };
      rows.set(key, { requestHash: input.requestHash, result: null, status: "started" });
      return { kind: "started" };
    },
    async complete(input) {
      const row = rows.get(`${input.userId}:${input.key}`)!;
      rows.set(`${input.userId}:${input.key}`, { ...row, result: input.result, status: "completed" });
    },
    async release(input) { rows.delete(`${input.userId}:${input.key}`); },
  };
}

const call = { action: "order" as const, key: "s1:call-1", request: { action: "order", total: 300 }, userId: "u1" };

describe("runLavkaOperation", () => {
  it("runs once and replays the stored result", async () => {
    const repo = ledger();
    const run = vi.fn(async () => ({ orderId: "o-1" }));
    await expect(runLavkaOperation(repo, call, run)).resolves.toEqual({ replayed: false, result: { orderId: "o-1" } });
    await expect(runLavkaOperation(repo, call, run)).resolves.toEqual({ replayed: true, result: { orderId: "o-1" } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("calls a replay of an unfinished attempt ambiguous instead of running it again", async () => {
    const repo = ledger();
    await repo.begin({ action: "order", key: call.key, requestHash: "x".repeat(64), userId: "u1" });
    repo.rows.set("u1:s1:call-1", { ...repo.rows.get("u1:s1:call-1")!, requestHash: (await import("node:crypto")).createHash("sha256").update(JSON.stringify(call.request)).digest("hex") });
    const run = vi.fn();
    await expect(runLavkaOperation(repo, call, run)).rejects.toMatchObject({ code: "AGENT_LAVKA_ORDER_AMBIGUOUS" });
    const addRepo = ledger();
    const add = { ...call, action: "add" as const, request: { action: "add" } };
    await runLavkaOperation(addRepo, add, async () => { throw new Error("socket hang up"); }).catch(() => undefined);
    await expect(runLavkaOperation(addRepo, add, run)).rejects.toMatchObject({ code: "AGENT_LAVKA_CART_AMBIGUOUS" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses another input under the same key", async () => {
    const repo = ledger();
    await runLavkaOperation(repo, call, async () => ({ orderId: "o-1" }));
    await expect(runLavkaOperation(repo, { ...call, request: { action: "order", total: 999 } }, vi.fn())).rejects.toMatchObject({ code: "AGENT_LAVKA_OPERATION_MISMATCH" });
  });

  it("frees the key after a refusal the site explained", async () => {
    const repo = ledger();
    await expect(runLavkaOperation(repo, call, async () => { throw new AppError("AGENT_LAVKA_ADDRESS_REQUIRED", "x"); })).rejects.toMatchObject({ code: "AGENT_LAVKA_ADDRESS_REQUIRED" });
    expect(repo.rows.size).toBe(0);
    await expect(runLavkaOperation(repo, call, async () => { throw new AppError("AGENT_LAVKA_CART_CHANGED", "x"); })).rejects.toMatchObject({ code: "AGENT_LAVKA_CART_CHANGED" });
    expect(repo.rows.size).toBe(0);
    await expect(runLavkaOperation(repo, call, async () => { throw new AppError("AGENT_LAVKA_UNAVAILABLE", "x"); })).rejects.toMatchObject({ code: "AGENT_LAVKA_UNAVAILABLE" });
    expect(repo.rows.get("u1:s1:call-1")).toMatchObject({ status: "started" });
  });
});
