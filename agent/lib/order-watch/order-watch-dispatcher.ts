/**
 * One minute tick of order watches.
 *
 * Exports:
 * - `createOrderWatchDispatcher`: injectable tick: claim the due watches, look at each order, tell
 *   the person what changed, and keep, reschedule or end the watch.
 * - `OrderObservation`: what a look at an order returned.
 * - `OrderWatchDeliveryRefusedError`: Telegram answered and did not take the message.
 *
 * Key constructs:
 * - What is about to be told is kept under the lease before it is sent: a crash after Telegram took
 *   the message never sends it again. A message Telegram refused is kept as not told, so the next
 *   tick tells it again; one whose fate is unknown (a timeout after the request left, an answer
 *   without a message id) counts as told and is never repeated; a chat that is gone ends the watch.
 * - The watch's own end (deadline, failed checks, a lost login) is kept as `ended` with its text,
 *   told, and only then closed: a refused message is told again on the next tick without a new look
 *   (a look that went fine must not cancel the end), a told one closes quietly. A kept final status
 *   of the order was told the same way and closes quietly (Codex review, 26 October 2026).
 * - A look that failed (a hung browser, the site not answering, the sandbox not running) is tried on
 *   the next tick, up to `ORDER_WATCH_MAX_FAILURES` in a row. A lost login, a blocked account and an
 *   order the site no longer knows end the watch at once, with a message saying why.
 * - Membership in the family is checked again right before the person's browser is used: a batch
 *   claimed a moment ago may hold someone removed since.
 * - Watches are looked at one after another: two of the same person share one browser.
 * - Logs carry codes, the service and the watch id, never addresses, cars or names.
 */
import { isAppError } from "../app-error.js";
import type { ProactiveDeliveryReceipt } from "../proactive-deliveries/proactive-delivery-repository.js";
import { TelegramRecipientUnreachableError } from "../memory-review/memory-review-owner-alert-transport.js";
import {
  ORDER_WATCH_BATCH_SIZE,
  ORDER_WATCH_DURATION_MS,
  ORDER_WATCH_INTERVAL_MS,
  ORDER_WATCH_LEASE_MS,
  ORDER_WATCH_MAX_FAILURES,
  type OrderWatchService,
} from "./order-watch-config.js";
import type { ClaimedOrderWatch, OrderWatchRepository } from "./order-watch-repository.js";
import {
  decideLavkaWatch,
  decideTaxiWatch,
  isFinalOrderState,
  type LavkaObservation,
  type OrderWatchDecision,
  type OrderWatchState,
  type TaxiObservation,
} from "./order-watch-status.js";

export type OrderObservation =
  | { service: "yandex_lavka"; lavka: LavkaObservation | null }
  | { service: "yandex_taxi"; taxi: TaxiObservation };

export class OrderWatchDeliveryRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Telegram sendMessage failed with HTTP ${status}.`);
    this.name = "OrderWatchDeliveryRefusedError";
  }
}

interface OrderWatchDispatcherDependencies {
  isMember(watch: ClaimedOrderWatch): Promise<boolean>;
  /** `busy`: the person's browser is in use by a turn; nothing was looked at. */
  observe(watch: ClaimedOrderWatch): Promise<OrderObservation | "busy">;
  record(watch: ClaimedOrderWatch, receipt: ProactiveDeliveryReceipt, deliveredAt: Date): Promise<void>;
  repository: Pick<OrderWatchRepository, "claimDue" | "finish" | "purgeFinished" | "release" | "reschedule" | "saveState">;
  send(watch: ClaimedOrderWatch, text: string): Promise<ProactiveDeliveryReceipt>;
}

type Ending = NonNullable<OrderWatchState["ended"]>;

const SERVICE_NAME: Readonly<Record<OrderWatchService, string>> = { yandex_lavka: "Лавки", yandex_taxi: "такси" };
/** A login, an account or an order that is gone does not come back by looking again. */
const FINAL_ERRORS: ReadonlySet<string> = new Set([
  "AGENT_LAVKA_AUTH_REQUIRED",
  "AGENT_YANDEX_TAXI_AUTH_REQUIRED",
  "AGENT_YANDEX_TAXI_BLOCKED",
]);
const ORDER_GONE_ERRORS: ReadonlySet<string> = new Set(["AGENT_YANDEX_TAXI_ORDER_NOT_FOUND"]);

const errorCode = (error: unknown): string => isAppError(error) ? error.code : "AGENT_ORDER_WATCH_CHECK_FAILED";
/** The person-facing part of an error: its text without the stable code prefix. */
const sentence = (text: string): string =>
  text.replace(/^[A-Z][A-Z0-9_]+:\s*/u, "").replace(/\s+/gu, " ").trim().replace(/[.!]+$/u, "").slice(0, 300);

function log(code: string, watch: ClaimedOrderWatch | null, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ code, ...(watch ? { service: watch.service, watchId: watch.id } : {}), ...extra }));
}

function decide(watch: ClaimedOrderWatch, observation: OrderObservation, now: Date): OrderWatchDecision {
  return observation.service === "yandex_taxi"
    ? decideTaxiWatch(watch.lastState, observation.taxi)
    : decideLavkaWatch(watch.lastState, observation.lavka, { sinceStartMs: now.getTime() - watch.createdAt.getTime() });
}

export function createOrderWatchDispatcher(dependencies: OrderWatchDispatcherDependencies) {
  const { repository } = dependencies;
  const nextCheck = (watch: ClaimedOrderWatch, now: Date) => new Date(now.getTime() + ORDER_WATCH_INTERVAL_MS[watch.service]);
  /** The state to keep when a message was refused: as if it had never been decided. */
  const notTold = (watch: ClaimedOrderWatch): OrderWatchState => watch.lastState ?? { status: null };
  /** What was told about the order, without an end of the watch being told. */
  const orderState = (watch: ClaimedOrderWatch): OrderWatchState => {
    const { endCode: _code, endRetry: _retry, endText: _text, ended: _ended, ...state } = notTold(watch);
    return state;
  };

  async function tell(watch: ClaimedOrderWatch, text: string): Promise<"refused" | "told" | "unreachable"> {
    try {
      const receipt = await dependencies.send(watch, text);
      await dependencies.record(watch, receipt, new Date()).catch((error: unknown) => {
        log("AGENT_ORDER_WATCH_HISTORY_FAILED", watch, { error: errorCode(error) });
      });
      return "told";
    } catch (error) {
      if (error instanceof TelegramRecipientUnreachableError) return "unreachable";
      if (error instanceof OrderWatchDeliveryRefusedError) {
        log("AGENT_ORDER_WATCH_DELIVERY_FAILED", watch, { status: error.status });
        return "refused";
      }
      // The request may have reached Telegram: a second copy is worse than one maybe lost.
      log("AGENT_ORDER_WATCH_DELIVERY_AMBIGUOUS", watch, { error: error instanceof Error ? error.name : "unknown" });
      return "told";
    }
  }

  async function end(watch: ClaimedOrderWatch, now: Date, ending: Ending, code: string | null, text: string): Promise<void> {
    const kept: OrderWatchState = { ...orderState(watch), endCode: code, endText: text, ended: ending };
    await repository.saveState(watch, kept);
    const told = await tell(watch, text);
    if (told === "refused") {
      await repository.reschedule(watch, { errorCode: "AGENT_ORDER_WATCH_DELIVERY_FAILED", nextCheckAt: nextCheck(watch, now), state: { ...kept, endRetry: true } });
      return;
    }
    await repository.finish(watch, told === "unreachable"
      ? { errorCode: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE", reason: "unreachable", state: null }
      : { errorCode: code, reason: ending, state: null });
  }

  async function check(watch: ClaimedOrderWatch, now: Date): Promise<void> {
    const service = SERVICE_NAME[watch.service];
    const kept = watch.lastState;
    if (kept?.ended) {
      // A refused end is told again; a told one only has the watch left to close.
      if (kept.endRetry && kept.endText) await end(watch, now, kept.ended, kept.endCode ?? null, kept.endText);
      else await repository.finish(watch, { errorCode: null, reason: kept.ended, state: null });
      return;
    }
    if (isFinalOrderState(watch.service, kept)) {
      await repository.finish(watch, { errorCode: null, reason: "order_ended", state: null });
      return;
    }
    if (now.getTime() >= watch.deadlineAt.getTime()) {
      const hours = Math.round(ORDER_WATCH_DURATION_MS / 3_600_000);
      await end(watch, now, "deadline", null, `Перестала следить за заказом ${service}: прошло ${hours} часов. Спросите меня о статусе, если нужно.`);
      return;
    }
    if (!await dependencies.isMember(watch)) {
      await repository.finish(watch, { errorCode: null, reason: "stopped", state: null });
      return;
    }
    let observation: OrderObservation | "busy";
    try {
      observation = await dependencies.observe(watch);
    } catch (error) {
      const code = errorCode(error);
      log("AGENT_ORDER_WATCH_CHECK_FAILED", watch, { error: code, failures: watch.failures + 1 });
      if (ORDER_GONE_ERRORS.has(code)) {
        await end(watch, now, "order_ended", code, `Перестала следить за заказом ${service}: сайт больше не находит этот заказ.`);
      } else if (FINAL_ERRORS.has(code)) {
        await end(watch, now, "failed", code, `Перестала следить за заказом ${service}: ${sentence(isAppError(error) ? error.message : code)}.`);
      } else if (watch.failures + 1 >= ORDER_WATCH_MAX_FAILURES) {
        await end(watch, now, "failed", code, `Не получается проверить заказ ${service} уже ${ORDER_WATCH_MAX_FAILURES} раз подряд, перестала следить. Спросите меня о статусе или посмотрите в приложении.`);
      } else {
        await repository.reschedule(watch, { errorCode: code, nextCheckAt: nextCheck(watch, now), state: null });
      }
      return;
    }
    if (observation === "busy") {
      // A turn is using the person's browser: the next tick looks again.
      await repository.release(watch);
      return;
    }
    const decision = decide(watch, observation, now);
    if (decision.message !== null) {
      await repository.saveState(watch, decision.state);
      const told = await tell(watch, decision.message);
      if (told === "unreachable") {
        await repository.finish(watch, { errorCode: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE", reason: "unreachable", state: decision.state });
        return;
      }
      if (told === "refused") {
        // Kept as not told: the next tick sees the same change and tells it again.
        await repository.reschedule(watch, { errorCode: "AGENT_ORDER_WATCH_DELIVERY_FAILED", nextCheckAt: nextCheck(watch, now), state: notTold(watch) });
        return;
      }
    }
    if (decision.finished) {
      await repository.finish(watch, { errorCode: null, reason: "order_ended", state: decision.state });
      return;
    }
    await repository.reschedule(watch, { errorCode: null, nextCheckAt: nextCheck(watch, now), state: decision.state });
  }

  return async function dispatchOrderWatches(now = new Date()): Promise<number> {
    let watches: ClaimedOrderWatch[];
    try {
      watches = await repository.claimDue({ leaseMilliseconds: ORDER_WATCH_LEASE_MS, limit: ORDER_WATCH_BATCH_SIZE, now });
    } catch (error) {
      // Eve settles the tick's promise without reporting it: without this line the watches stop silently.
      log("AGENT_ORDER_WATCH_TICK_FAILED", null, { error: errorCode(error), stage: "claim" });
      return 0;
    }
    for (const watch of watches) {
      try {
        await check(watch, now);
      } catch (error) {
        // A stale lease belongs to another tick; anything else leaves the lease to expire and retry.
        log(errorCode(error) === "AGENT_ORDER_WATCH_LEASE_STALE" ? "AGENT_ORDER_WATCH_LEASE_STALE" : "AGENT_ORDER_WATCH_TICK_FAILED", watch, { error: errorCode(error) });
      }
    }
    await repository.purgeFinished(now).catch((error: unknown) => log("AGENT_ORDER_WATCH_PURGE_FAILED", null, { error: errorCode(error) }));
    return watches.length;
  };
}
