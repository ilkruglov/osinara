/**
 * The `yandex_taxi` tool: where it exists, what it asks to confirm, what it accepts and how an order runs.
 *
 * Constructs covered:
 * - Only a private chat has the tool; a family group, an external group and a group turn reaching
 *   the executor are refused before any browser call, and so is a person no longer in the family.
 * - order and cancel ask for a confirmation, everything else does not, also after dynamic emission.
 * - Each action accepts only its own fields and requires the ones it needs; an order needs the
 *   payment exactly as estimate gave it.
 * - An order runs once under `session:callId` after the approval check, with the confirmed input,
 *   and is then watched; watch follows a ride ordered elsewhere from its current status, unwatch stops.
 * - An edited point is answered with "take it again from places or suggest", never with the generic
 *   "fix the arguments"; the second one in a turn stops estimate and order for the rest of the turn.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  estimate: vi.fn(),
  placeOrder: vi.fn(),
  requireMember: vi.fn(),
  requireToolApprovalEvidence: vi.fn(),
  startWatch: vi.fn(),
  status: vi.fn(),
  stopWatch: vi.fn(),
  rows: new Map<string, { requestHash: string; result: unknown; status: "completed" | "started" }>(),
}));

vi.mock("./yandex-taxi-production.js", () => ({
  yandexTaxiClientFor: () => ({ auth: mocks.auth, estimate: mocks.estimate, placeOrder: mocks.placeOrder, status: mocks.status }),
}));
vi.mock("../order-watch/order-watch-start.js", () => ({ startOrderWatch: mocks.startWatch, stopOrderWatches: mocks.stopWatch }));
vi.mock("../require-tool-approval-evidence.js", () => ({ requireToolApprovalEvidence: mocks.requireToolApprovalEvidence }));
vi.mock("./yandex-taxi-operation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./yandex-taxi-operation.js")>(),
  requireYandexTaxiFamilyMember: mocks.requireMember,
  yandexTaxiOperationRepository: {
    async begin(input: { key: string; requestHash: string; userId: string }) {
      const row = mocks.rows.get(`${input.userId}:${input.key}`);
      if (row) return { kind: "existing", ...row };
      mocks.rows.set(`${input.userId}:${input.key}`, { requestHash: input.requestHash, result: null, status: "started" });
      return { kind: "started" };
    },
    async complete(input: { key: string; result: unknown; userId: string }) {
      mocks.rows.set(`${input.userId}:${input.key}`, { ...mocks.rows.get(`${input.userId}:${input.key}`)!, result: input.result, status: "completed" });
    },
    async release(input: { key: string; userId: string }) { mocks.rows.delete(`${input.userId}:${input.key}`); },
  },
}));

import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";
import yandexTaxi from "../tools/yandex_taxi.js";
import { yandexTaxiInput } from "./yandex-taxi-input.js";
import { fromPoint, toPoint } from "./yandex-taxi.test-fixtures.js";

function context(kind: "external" | "family" | "private", callId = "call-1", turnId = "turn-1"): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      ...(kind === "private" ? {} : { groupId: "group-1" }),
      memoryScopes: kind === "external" ? ["group"] : kind === "family" ? ["family"] : ["personal", "family"],
      role: kind === "external" ? "external" : "member",
      telegramActorId: "101",
      telegramActorKind: "telegram_user",
      telegramChatId: kind === "private" ? "101" : "-1001",
      telegramChatType: kind === "private" ? "private" : "supergroup",
      telegramUserId: "101",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { callId, session: { auth: { current: caller, initiator: caller }, id: "session-1", turn: { id: turnId, sequence: 1 } } } as unknown as ToolContext;
}

const orderInput = {
  action: "order" as const, currency: "₽", fixedPrice: true, from: fromPoint, payment: { id: "card-1", label: "карта MIR ••1234", type: "card" as const },
  price: 350, tariff: "econom", tariffName: "Эконом", to: toPoint, waitingMinutes: 4,
};

const approval = (toolInput: Record<string, unknown>) => (yandexTaxi as unknown as { approval: (c: { toolInput: Record<string, unknown> }) => unknown }).approval({ toolInput });

describe("yandex_taxi", () => {
  beforeEach(() => {
    mocks.rows.clear();
    mocks.placeOrder.mockReset();
    mocks.requireToolApprovalEvidence.mockReset();
    mocks.auth.mockReset().mockResolvedValue({ state: "ready" });
    mocks.requireMember.mockReset().mockResolvedValue(undefined);
    mocks.startWatch.mockReset().mockResolvedValue(true);
    mocks.stopWatch.mockReset().mockResolvedValue(1);
    mocks.status.mockReset();
  });

  it("exists only in a private chat and keeps its confirmation after dynamic emission", () => {
    const privateSurface = buildModeToolSurface({ environment: "private" });
    expect(privateSurface).toHaveProperty("yandex_taxi");
    expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty("yandex_taxi");
    expect(buildModeToolSurface({ capabilities: new Set(), environment: "external" })).not.toHaveProperty("yandex_taxi");
    expect(privateSurface.yandex_taxi!.approval).toBeTypeOf("function");
    // 1 100 until 26 October 2026; the watch sentence added about 160.
    expect(privateSurface.yandex_taxi!.description.length).toBeLessThan(1_250);
  });

  it("asks to confirm an order and a cancellation only", () => {
    expect(approval(orderInput)).toBe("user-approval");
    expect(approval({ action: "cancel", cancelState: "free", orderId: "o-1" })).toBe("user-approval");
    for (const action of ["auth", "places", "suggest", "estimate", "status", "watch", "unwatch"]) expect(approval({ action })).toBe("not-applicable");
  });

  it("accepts only each action's own fields and requires the ones it needs", () => {
    expect(yandexTaxiInput.safeParse(orderInput).success).toBe(true);
    expect(yandexTaxiInput.safeParse({ action: "estimate", from: fromPoint, to: toPoint }).success).toBe(true);
    expect(yandexTaxiInput.safeParse({ action: "suggest", query: "Тверская 1", type: "to" }).success).toBe(true);
    expect(yandexTaxiInput.safeParse({ action: "suggest", near: { lat: 55.7539, lon: 37.6208 }, type: "from" }).success).toBe(true);
    expect(yandexTaxiInput.safeParse({ action: "suggest", type: "from" }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ action: "suggest", near: { lat: 55.7539, lon: 37.6208 }, pick: 1, type: "from" }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ action: "estimate", from: fromPoint, price: 1, to: toPoint }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ action: "estimate", from: fromPoint }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ ...orderInput, price: undefined }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ ...orderInput, offer: "offer-1" }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ ...orderInput, payment: { id: "card-1", type: "card" } }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ ...orderInput, payment: { label: "карта", type: "card" } }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ ...orderInput, payment: { label: "наличные", type: "cash" } }).success).toBe(true);
    expect(yandexTaxiInput.safeParse({ ...orderInput, from: { ...fromPoint, name: "Дом" } }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ action: "cancel", orderId: "o-1" }).success).toBe(false);
    expect(yandexTaxiInput.safeParse({ action: "auth", userId: "someone-else" }).success).toBe(false);
  });

  it("refuses a family group and an external group before any browser call", async () => {
    for (const kind of ["family", "external"] as const) {
      await expect(yandexTaxi.execute({ action: "auth" }, context(kind))).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ACCESS_DENIED" });
    }
    await expect(yandexTaxi.execute({ action: "auth" }, context("private"))).resolves.toEqual({ state: "ready" });
    expect(mocks.requireMember).toHaveBeenCalledWith("family-1", "user-1");
  });

  it("refuses a person removed from the family since the turn began, before any browser call", async () => {
    mocks.requireMember.mockRejectedValue(Object.assign(new Error("x"), { code: "AGENT_YANDEX_TAXI_ACCESS_DENIED" }));
    for (const input of [{ action: "auth" as const }, orderInput]) {
      await expect(yandexTaxi.execute(input, context("private", `call-${input.action}`))).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ACCESS_DENIED" });
    }
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.placeOrder).not.toHaveBeenCalled();
    expect(mocks.rows.size).toBe(0);
  });

  it("never hands the model the opaque offer of an estimate", async () => {
    mocks.estimate.mockResolvedValue({ currency: "₽", offer: "offer-secret", tariffs: [] });
    const shown = await yandexTaxi.execute({ action: "estimate", from: fromPoint, to: toPoint }, context("private"));
    expect(shown).toMatchObject({ currency: "₽", tariffs: [] });
    expect(JSON.stringify(shown)).not.toContain("offer");
  });

  it("orders once under the call id after the approval check, with the confirmed input", async () => {
    mocks.placeOrder.mockResolvedValue({ note: "Заказ принят.", orderId: "o-1", status: "search" });
    const placed = { note: "Заказ принят. Статус пришлю сама: машину, подачу и конец поездки.", orderId: "o-1", status: "search", watching: true };
    await expect(yandexTaxi.execute(orderInput, context("private"))).resolves.toEqual(placed);
    await expect(yandexTaxi.execute(orderInput, context("private"))).resolves.toEqual(placed);
    expect(mocks.startWatch).toHaveBeenCalledWith(expect.anything(), { familyId: "family-1", initialState: null, orderId: "o-1", service: "yandex_taxi", userId: "user-1" });
    expect(mocks.placeOrder).toHaveBeenCalledTimes(1);
    expect(mocks.requireToolApprovalEvidence).toHaveBeenCalledWith(expect.anything(), "yandex_taxi", orderInput);
    expect(mocks.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ payment: { id: "card-1", label: "карта MIR ••1234", type: "card" }, price: 350, tariff: "econom" }));
    expect([...mocks.rows.keys()]).toEqual(["user-1:session-1:call-1"]);

    mocks.requireToolApprovalEvidence.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID" }));
    await expect(yandexTaxi.execute(orderInput, context("private", "call-2"))).rejects.toThrow();
    expect(mocks.placeOrder).toHaveBeenCalledTimes(1);
  });

  // 27 October 2026: after Yandex refused the draft, the model "fixed" the point five times in one
  // turn, because the generic correction for an input error says to fix the arguments and retry.
  it("asks for a fresh point instead of a fixed one, and stops the second time in a turn", async () => {
    const failure = async (run: () => unknown) => { try { await run(); } catch (error) { return error; } return null; };
    const edited = () => new AppError("AGENT_YANDEX_TAXI_POINT_REF_INVALID", "Точка откуда изменена после places или suggest. Передайте объект point ровно из их ответа");
    mocks.estimate.mockRejectedValue(edited());
    const first = await failure(() => yandexTaxi.execute({ action: "estimate", from: fromPoint, to: toPoint }, context("private", "call-1", "turn-9")));
    expect(first).toMatchObject({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID", contract: { retryable: true, sideEffectStatus: "not_started" } });
    expect((first as { contract: { correction: string } }).contract.correction).toMatch(/не правь.*places.*suggest/su);
    const second = await failure(() => yandexTaxi.execute({ action: "estimate", from: fromPoint, to: toPoint }, context("private", "call-2", "turn-9")));
    expect(second).toMatchObject({ code: "AGENT_YANDEX_TAXI_POINT_REF_REPEATED", contract: { retryable: false } });
    expect((second as { contract: { correction: string } }).contract.correction).toMatch(/в этом ходе.*человеку/su);
    // A new turn starts over.
    const next = await failure(() => yandexTaxi.execute({ action: "estimate", from: fromPoint, to: toPoint }, context("private", "call-3", "turn-10")));
    expect(next).toMatchObject({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID" });
  });

  // Codex review of 1.8.54: `order` builds its confirmation window from the points before execute,
  // so an edited point there never met the guard and reached the model without its correction.
  it("denies an order with an edited point before its confirmation, with the same correction and stop", async () => {
    const policy = buildModeToolSurface({ environment: "private" }).yandex_taxi!.approval as unknown as (ctx: unknown) => Promise<unknown>;
    const edited = { ...orderInput, from: { ...fromPoint, fullText: "Россия, Москва, другая улица, 1" } };
    const ask = (turnId: string) => policy({ ...context("private", "call-1", turnId), toolInput: edited });

    // The denial reason is the error text: its stable code, then the correction contract as JSON.
    const contract = (denial: unknown) => JSON.parse((denial as { reason: string }).reason.replace(/^[A-Z_]+:\s*/u, ""));
    const first = await ask("turn-21") as { type: string };
    expect(first.type).toBe("denied");
    expect(contract(first)).toMatchObject({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID", retryable: true });
    expect(contract(first).correction).toMatch(/не правь.*places.*suggest/su);
    expect(contract(await ask("turn-21"))).toMatchObject({ code: "AGENT_YANDEX_TAXI_POINT_REF_REPEATED" });
    expect(await policy({ ...context("private", "call-2", "turn-22"), toolInput: orderInput })).toBe("user-approval");
  });

  it("watches a ride ordered elsewhere from where it is now, refuses a finished one, and stops on request", async () => {
    mocks.status.mockResolvedValueOnce({ activeOrders: [], order: { car: "Белый Kia Rio", driver: "Иван", finalCost: null, minutesLeft: 4, orderId: "o-9", plates: "А123ВС777", status: "driving", statusText: "машина едет к вам" } });
    await expect(yandexTaxi.execute({ action: "watch" }, context("private"))).resolves.toEqual({ orderId: "o-9", status: "машина едет к вам", watching: true });
    expect(mocks.startWatch).toHaveBeenCalledWith(expect.anything(), {
      familyId: "family-1", initialState: { car: "Белый Kia Rio", plates: "А123ВС777", status: "driving" }, orderId: "o-9", service: "yandex_taxi", userId: "user-1",
    });
    mocks.status.mockResolvedValueOnce({ activeOrders: [], order: { car: null, driver: null, finalCost: "540 ₽", minutesLeft: null, orderId: "o-8", plates: null, status: "complete", statusText: "поездка завершена" } });
    await expect(yandexTaxi.execute({ action: "watch", orderId: "o-8" }, context("private"))).resolves.toMatchObject({ watching: false });
    mocks.status.mockResolvedValueOnce({ activeOrders: [], order: null });
    await expect(yandexTaxi.execute({ action: "watch" }, context("private"))).rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ORDER_NOT_FOUND" });
    expect(mocks.startWatch).toHaveBeenCalledTimes(1);
    await expect(yandexTaxi.execute({ action: "unwatch" }, context("private"))).resolves.toEqual({ stopped: 1 });
    expect(mocks.stopWatch).toHaveBeenCalledWith({ orderId: undefined, service: "yandex_taxi", userId: "user-1" });
  });
});
