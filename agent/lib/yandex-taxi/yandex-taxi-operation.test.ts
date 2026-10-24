/**
 * Exactly-once Yandex Go side effects over an in-memory ledger.
 *
 * Constructs covered:
 * - The first call runs and stores its result; a replay of the same call returns it without
 *   touching Yandex Go again.
 * - A replay of a call whose first attempt never finished is ambiguous (order or cancel wording),
 *   and an ambiguous order keeps its key.
 * - A different input under the same key is refused.
 * - A refusal Yandex Go explained frees the key, and so does a failure marked as having sent
 *   nothing; an unknown failure keeps it.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { runYandexTaxiOperation, type YandexTaxiOperationRepository } from "./yandex-taxi-operation.js";
import { yandexTaxiNothingSent } from "./yandex-taxi-transport.js";

type Row = { requestHash: string; result: unknown; status: "completed" | "started" };

function ledger(): YandexTaxiOperationRepository & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
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
      const key = `${input.userId}:${input.key}`;
      rows.set(key, { ...rows.get(key)!, result: input.result, status: "completed" });
    },
    async release(input) { rows.delete(`${input.userId}:${input.key}`); },
  };
}

const call = { action: "order" as const, familyId: "f1", key: "s1:call-1", request: { action: "order", price: 350 }, userId: "u1" };

describe("runYandexTaxiOperation", () => {
  it("runs once and replays the stored result", async () => {
    const repo = ledger();
    const run = vi.fn(async () => ({ orderId: "o-1" }));
    await expect(runYandexTaxiOperation(repo, call, run)).resolves.toEqual({ replayed: false, result: { orderId: "o-1" } });
    await expect(runYandexTaxiOperation(repo, call, run)).resolves.toEqual({ replayed: true, result: { orderId: "o-1" } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("calls a replay of an unfinished attempt ambiguous instead of running it again", async () => {
    const repo = ledger();
    await runYandexTaxiOperation(repo, call, async () => { throw new AppError("AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS", "x"); }).catch(() => undefined);
    expect(repo.rows.get("u1:s1:call-1")).toMatchObject({ status: "started" });
    const run = vi.fn();
    await expect(runYandexTaxiOperation(repo, call, run)).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS" });
    const cancel = { ...call, action: "cancel" as const, key: "s1:call-2", request: { action: "cancel" } };
    await runYandexTaxiOperation(repo, cancel, async () => { throw new Error("socket hang up"); }).catch(() => undefined);
    await expect(runYandexTaxiOperation(repo, cancel, run)).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_CANCEL_AMBIGUOUS" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses another input under the same key", async () => {
    const repo = ledger();
    await runYandexTaxiOperation(repo, call, async () => ({ orderId: "o-1" }));
    await expect(runYandexTaxiOperation(repo, { ...call, request: { action: "order", price: 999 } }, vi.fn())).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_OPERATION_MISMATCH" });
  });

  it("frees the key after a refusal Yandex Go explained and keeps it after an unknown failure", async () => {
    const repo = ledger();
    for (const code of ["AGENT_YANDEX_TAXI_PRICE_CHANGED", "AGENT_YANDEX_TAXI_ORDER_ACTIVE", "AGENT_YANDEX_TAXI_CAPTCHA", "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID"]) {
      await expect(runYandexTaxiOperation(repo, call, async () => { throw new AppError(code, "x"); })).rejects.toMatchObject({ code });
      expect(repo.rows.size, code).toBe(0);
    }
    await expect(runYandexTaxiOperation(repo, call, async () => { throw new AppError("AGENT_YANDEX_TAXI_UNAVAILABLE", "x"); })).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_UNAVAILABLE" });
    expect(repo.rows.get("u1:s1:call-1")).toMatchObject({ status: "started" });
  });

  it("frees the key after a failure that sent nothing, whatever its code", async () => {
    const repo = ledger();
    const failure = yandexTaxiNothingSent(new AppError("AGENT_YANDEX_TAXI_UNAVAILABLE", "x"));
    await expect(runYandexTaxiOperation(repo, call, async () => { throw failure; })).rejects.toBe(failure);
    expect(repo.rows.size).toBe(0);
  });
});
