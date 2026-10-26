/**
 * Order watch tick tests.
 *
 * Constructs covered:
 * - A changed status is kept before it is sent and recorded in the person's notification history;
 *   an unchanged one reschedules quietly.
 * - A message Telegram refused is told again on the next tick; one whose fate is unknown (a timeout
 *   after sending) is not repeated; a chat that is gone ends the watch.
 * - A failed look reschedules and counts; the last allowed failure, a lost login and an order the
 *   site no longer knows end the watch with a message saying why. Such an end is kept with its text
 *   before it is told; a refused one is told again on the next tick without looking at the order, a
 *   told one closes quietly. A final status already told closes quietly too.
 * - A watch past its deadline ends without looking at the order; one of a person who left the
 *   family ends without a word; a busy browser leaves the watch for the next tick.
 * - A lease another tick took writes nothing more; a failing tick start is logged by its code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { TelegramRecipientUnreachableError } from "../memory-review/memory-review-owner-alert-transport.js";
import { ORDER_WATCH_MAX_FAILURES } from "./order-watch-config.js";
import { createOrderWatchDispatcher, OrderWatchDeliveryRefusedError, type OrderObservation } from "./order-watch-dispatcher.js";
import type { ClaimedOrderWatch } from "./order-watch-repository.js";

const NOW = new Date("2026-10-26T12:00:00Z");
const NEXT = new Date(NOW.getTime() + 60_000);

function watch(overrides: Partial<ClaimedOrderWatch> = {}): ClaimedOrderWatch {
  return {
    createdAt: new Date("2026-10-26T11:50:00Z"), deadlineAt: new Date("2026-10-26T17:50:00Z"), failures: 0,
    familyId: "family-1", id: "watch-1", lastState: { car: null, plates: null, status: "search" }, leaseToken: "lease-1",
    orderId: "order-1", sandboxSessionId: "thread-1", service: "yandex_taxi", telegramChatId: "101", userId: "user-1",
    ...overrides,
  };
}

const driving: OrderObservation = { service: "yandex_taxi", taxi: { car: "Белый Kia Rio", driver: null, finalCost: null, minutesLeft: 5, plates: "А123ВС777", status: "driving" } };
const drivingState = { car: "Белый Kia Rio", plates: "А123ВС777", status: "driving" };
const browserTimeout = () => new AppError("AGENT_BROWSER_TIMEOUT", "Браузер не ответил");

function harness(claimed: ClaimedOrderWatch[], observe: (watch: ClaimedOrderWatch) => Promise<OrderObservation | "busy">, options: { member?: boolean } = {}) {
  const repository = {
    claimDue: vi.fn().mockResolvedValue(claimed),
    finish: vi.fn().mockResolvedValue(undefined),
    purgeFinished: vi.fn().mockResolvedValue(0),
    release: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(undefined),
  };
  const send = vi.fn().mockResolvedValue({ messageId: "900", text: "" });
  const record = vi.fn().mockResolvedValue(undefined);
  const observeSpy = vi.fn(observe);
  const isMember = vi.fn().mockResolvedValue(options.member ?? true);
  const dispatch = createOrderWatchDispatcher({ isMember, observe: observeSpy, record, repository, send });
  return { dispatch, observe: observeSpy, record, repository, send };
}

describe("order watch dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the new status, then tells it and records it in the notification history", async () => {
    const { dispatch, record, repository, send } = harness([watch()], async () => driving);
    await dispatch(NOW);
    expect(repository.saveState).toHaveBeenCalledWith(expect.objectContaining({ id: "watch-1" }), drivingState);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: "watch-1" }), "Такси едет: Белый Kia Rio, А123ВС777, будет через 5 мин.");
    expect(repository.saveState.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ id: "watch-1" }), { messageId: "900", text: "" }, expect.any(Date));
    expect(repository.reschedule).toHaveBeenCalledWith(expect.objectContaining({ id: "watch-1" }), { errorCode: null, nextCheckAt: NEXT, state: drivingState });
    expect(repository.purgeFinished).toHaveBeenCalledOnce();
  });

  it("reschedules quietly when nothing changed and ends with the order", async () => {
    const quiet = harness([watch({ lastState: drivingState })], async () => driving);
    await quiet.dispatch(NOW);
    expect(quiet.send).not.toHaveBeenCalled();
    expect(quiet.repository.reschedule).toHaveBeenCalledOnce();

    const ended = harness([watch({ lastState: { status: "transporting" } })], async () => ({ service: "yandex_taxi", taxi: { ...driving.taxi, status: "complete" } }));
    await ended.dispatch(NOW);
    expect(ended.send).toHaveBeenCalledWith(expect.anything(), "Поездка завершена.");
    expect(ended.repository.finish).toHaveBeenCalledWith(expect.anything(), { errorCode: null, reason: "order_ended", state: { car: "Белый Kia Rio", plates: "А123ВС777", status: "complete" } });
  });

  it("tells again a message Telegram refused, never one whose fate is unknown, and stops for a chat that is gone", async () => {
    const refused = harness([watch()], async () => driving);
    refused.send.mockRejectedValueOnce(new OrderWatchDeliveryRefusedError(429));
    await refused.dispatch(NOW);
    expect(refused.repository.reschedule).toHaveBeenCalledWith(expect.anything(), { errorCode: "AGENT_ORDER_WATCH_DELIVERY_FAILED", nextCheckAt: NEXT, state: { car: null, plates: null, status: "search" } });
    expect(refused.record).not.toHaveBeenCalled();

    const unknown = harness([watch()], async () => driving);
    unknown.send.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    await unknown.dispatch(NOW);
    expect(unknown.repository.reschedule).toHaveBeenCalledWith(expect.anything(), { errorCode: null, nextCheckAt: NEXT, state: drivingState });

    const gone = harness([watch()], async () => driving);
    gone.send.mockRejectedValueOnce(new TelegramRecipientUnreachableError("101", "blocked"));
    await gone.dispatch(NOW);
    expect(gone.repository.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "unreachable" }));
  });

  it("counts a failed look and gives up on the last one, telling why before the watch closes", async () => {
    const hung = harness([watch({ failures: 2 })], async () => { throw browserTimeout(); });
    await hung.dispatch(NOW);
    expect(hung.repository.reschedule).toHaveBeenCalledWith(expect.anything(), { errorCode: "AGENT_BROWSER_TIMEOUT", nextCheckAt: NEXT, state: null });
    expect(hung.send).not.toHaveBeenCalled();

    const last = harness([watch({ failures: ORDER_WATCH_MAX_FAILURES - 1 })], async () => { throw browserTimeout(); });
    await last.dispatch(NOW);
    const failedText = `Не получается проверить заказ такси уже ${ORDER_WATCH_MAX_FAILURES} раз подряд, перестала следить. Спросите меня о статусе или посмотрите в приложении.`;
    expect(last.repository.saveState).toHaveBeenCalledWith(expect.anything(), { car: null, endCode: "AGENT_BROWSER_TIMEOUT", endText: failedText, ended: "failed", plates: null, status: "search" });
    expect(last.send.mock.calls[0]?.[1]).toMatch(/^Не получается проверить заказ такси/u);
    expect(last.repository.finish).toHaveBeenCalledWith(expect.anything(), { errorCode: "AGENT_BROWSER_TIMEOUT", reason: "failed", state: null });
    expect(last.send.mock.invocationCallOrder[0]).toBeLessThan(last.repository.finish.mock.invocationCallOrder[0]!);

    const refusedEnd = harness([watch({ failures: ORDER_WATCH_MAX_FAILURES - 1 })], async () => { throw browserTimeout(); });
    refusedEnd.send.mockRejectedValueOnce(new OrderWatchDeliveryRefusedError(502));
    await refusedEnd.dispatch(NOW);
    expect(refusedEnd.repository.finish).not.toHaveBeenCalled();
    expect(refusedEnd.repository.reschedule).toHaveBeenCalledWith(expect.anything(), {
      errorCode: "AGENT_ORDER_WATCH_DELIVERY_FAILED", nextCheckAt: NEXT,
      state: { car: null, endCode: "AGENT_BROWSER_TIMEOUT", endRetry: true, endText: failedText, ended: "failed", plates: null, status: "search" },
    });

    // The refused end is told again without a new look, even if the order would look fine now.
    const retry = harness([watch({ lastState: { endCode: "AGENT_BROWSER_TIMEOUT", endRetry: true, endText: failedText, ended: "failed", status: "search" } })], async () => driving);
    await retry.dispatch(NOW);
    expect(retry.observe).not.toHaveBeenCalled();
    expect(retry.send).toHaveBeenCalledWith(expect.anything(), failedText);
    expect(retry.repository.finish).toHaveBeenCalledWith(expect.anything(), { errorCode: "AGENT_BROWSER_TIMEOUT", reason: "failed", state: null });

    const told = harness([watch({ lastState: { ended: "failed", status: "search" } })], async () => driving);
    await told.dispatch(NOW);
    expect(told.observe).not.toHaveBeenCalled();
    expect(told.send).not.toHaveBeenCalled();
    expect(told.repository.finish).toHaveBeenCalledWith(expect.anything(), { errorCode: null, reason: "failed", state: null });
  });

  it("closes quietly a watch whose final status was already told", async () => {
    for (const [service, status] of [["yandex_taxi", "complete"], ["yandex_taxi", "cancelled"], ["yandex_lavka", "closed"], ["yandex_lavka", "gone"]] as const) {
      const done = harness([watch({ lastState: { seen: true, status }, service })], async () => ({ lavka: null, service: "yandex_lavka" }));
      await done.dispatch(NOW);
      expect(done.observe).not.toHaveBeenCalled();
      expect(done.send).not.toHaveBeenCalled();
      expect(done.repository.finish).toHaveBeenCalledWith(expect.anything(), { errorCode: null, reason: "order_ended", state: null });
    }
  });

  it("stops at once without a login or an order", async () => {
    const loggedOut = harness([watch({ service: "yandex_lavka" })], async () => { throw new AppError("AGENT_LAVKA_AUTH_REQUIRED", "Лавка не узнаёт вход"); });
    await loggedOut.dispatch(NOW);
    expect(loggedOut.repository.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ errorCode: "AGENT_LAVKA_AUTH_REQUIRED", reason: "failed" }));
    expect(loggedOut.send.mock.calls[0]?.[1]).toBe("Перестала следить за заказом Лавки: Лавка не узнаёт вход.");

    const unknownOrder = harness([watch()], async () => { throw new AppError("AGENT_YANDEX_TAXI_ORDER_NOT_FOUND", "Яндекс Go не нашёл такой заказ"); });
    await unknownOrder.dispatch(NOW);
    expect(unknownOrder.repository.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "order_ended" }));
  });

  it("ends a watch past its deadline without looking, and one of a person who left the family without a word", async () => {
    const late = harness([watch({ deadlineAt: new Date("2026-10-26T11:59:00Z") })], async () => driving);
    await late.dispatch(NOW);
    expect(late.observe).not.toHaveBeenCalled();
    expect(late.repository.finish).toHaveBeenCalledWith(expect.anything(), { errorCode: null, reason: "deadline", state: null });
    expect(late.send.mock.calls[0]?.[1]).toBe("Перестала следить за заказом такси: прошло 6 часов. Спросите меня о статусе, если нужно.");

    const left = harness([watch()], async () => driving, { member: false });
    await left.dispatch(NOW);
    expect(left.observe).not.toHaveBeenCalled();
    expect(left.send).not.toHaveBeenCalled();
    expect(left.repository.finish).toHaveBeenCalledWith(expect.anything(), { errorCode: null, reason: "stopped", state: null });
  });

  it("leaves a watch whose browser is busy for the next tick", async () => {
    const busy = harness([watch()], async () => "busy");
    await busy.dispatch(NOW);
    expect(busy.repository.release).toHaveBeenCalledWith(expect.objectContaining({ id: "watch-1" }));
    expect(busy.repository.reschedule).not.toHaveBeenCalled();
    expect(busy.send).not.toHaveBeenCalled();
  });

  it("writes nothing more after another tick took the lease, and logs a tick that could not start", async () => {
    const stale = harness([watch()], async () => driving);
    stale.repository.saveState.mockRejectedValueOnce(new AppError("AGENT_ORDER_WATCH_LEASE_STALE", "занято"));
    await stale.dispatch(NOW);
    expect(stale.send).not.toHaveBeenCalled();
    expect(stale.repository.reschedule).not.toHaveBeenCalled();

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = harness([], async () => driving);
    down.repository.claimDue.mockRejectedValueOnce(new Error("connection refused"));
    await expect(down.dispatch(NOW)).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AGENT_ORDER_WATCH_TICK_FAILED"));
  });
});
