/**
 * What the person is told when a watched order moves on.
 *
 * Exports:
 * - `decideTaxiWatch`, `decideLavkaWatch`: from what was last told and what is seen now, the message
 *   (or none), the state to keep and whether the watch ends.
 * - `isFinalOrderState`: the kept state already names the order's end, so it was told.
 * - `OrderWatchState`, `OrderWatchDecision`, `TaxiObservation`, `LavkaObservation`.
 *
 * Key constructs:
 * - Only a change worth a message is told: a car found or changed, a car on the spot, the ride, the
 *   end. Minutes ticking down and a status seen again stay quiet; the person can always ask.
 * - Messages are fixed templates filled with what the site returned, never model text: the watch
 *   runs between turns, without a model.
 * - The end of an order is told once: when the message went but ending the watch failed, the kept
 *   state already names that end, and the next look ends the watch quietly (Codex review,
 *   26 October 2026). A Lavka order that left the tracked list is kept as `gone` for the same reason.
 */
import { yandexTaxiStatusLabel } from "../yandex-taxi/yandex-taxi-model.js";
import { ORDER_WATCH_UNSEEN_GRACE_MS } from "./order-watch-config.js";

export interface OrderWatchState {
  car?: string | null;
  /** The watch's own end (a deadline, failed checks) is being told: its reason, code and text. */
  ended?: "deadline" | "failed" | "order_ended";
  endCode?: string | null;
  /** Telegram refused the end's message: it is told again, without looking at the order. */
  endRetry?: boolean;
  endText?: string;
  plates?: string | null;
  /** Lavka: the order has appeared among the tracked ones at least once. */
  seen?: boolean;
  status: string | null;
}

export interface OrderWatchDecision {
  finished: boolean;
  message: string | null;
  state: OrderWatchState;
}

export interface TaxiObservation {
  car: string | null;
  driver: string | null;
  finalCost: string | null;
  minutesLeft: number | null;
  plates: string | null;
  status: string;
}

export interface LavkaObservation {
  status: string;
  subtitle: string;
  title: string;
}

const clip = (value: string, max = 200): string => value.replace(/\s+/gu, " ").trim().slice(0, max);
const sentence = (value: string): string => `${clip(value).replace(/[.!…]+$/u, "")}.`;

/** Statuses that read the same to a person: Yandex Go waits first silently, then calls. */
const TAXI_PHASE: Readonly<Record<string, string>> = { calling: "arrived", waiting: "arrived" };
const TAXI_QUIET: ReadonlySet<string> = new Set(["boarding", "draft", "scheduling", "search"]);
const TAXI_FINAL: Readonly<Record<string, string>> = {
  cancelled: "Заказ такси отменён.",
  expired: "Яндекс Go не нашёл машину, заказ закрыт.",
  failed: "Заказ такси не выполнен.",
};

function carLine(observed: TaxiObservation, withDriver: boolean): string {
  return [
    observed.car,
    observed.plates,
    withDriver && observed.driver ? `водитель ${observed.driver}` : null,
    observed.minutesLeft === null ? null : `будет через ${observed.minutesLeft} мин`,
  ].filter((part): part is string => Boolean(part)).map((part) => clip(part, 100)).join(", ");
}

export function decideTaxiWatch(previous: OrderWatchState | null, observed: TaxiObservation): OrderWatchDecision {
  const state: OrderWatchState = { car: observed.car, plates: observed.plates, status: observed.status };
  const phase = (status: string | null | undefined) => (status ? TAXI_PHASE[status] ?? status : null);
  const final = TAXI_FINAL[observed.status];
  const ended = final !== undefined || observed.status === "complete";
  if (ended && previous?.status === observed.status) return { finished: true, message: null, state };
  if (final) return { finished: true, message: final, state };
  if (observed.status === "complete") {
    return { finished: true, message: `Поездка завершена${observed.finalCost ? `, стоимость ${clip(observed.finalCost, 40)}` : ""}.`, state };
  }
  const samePhase = phase(previous?.status) === phase(observed.status);
  if (observed.status === "driving") {
    if (!samePhase) return { finished: false, message: `Такси едет: ${carLine(observed, true)}.`, state };
    const carChanged = Boolean(observed.plates) && observed.plates !== previous?.plates;
    return { finished: false, message: carChanged ? `Сменилась машина: ${carLine(observed, false)}.` : null, state };
  }
  if (samePhase || TAXI_QUIET.has(observed.status)) return { finished: false, message: null, state };
  const message = phase(observed.status) === "arrived"
    ? `Такси на месте: ${carLine({ ...observed, minutesLeft: null }, false)}.`
    : observed.status === "transporting" ? "Поездка началась."
    : observed.status === "preexpired" ? "Машину пока не нашли, поиск скоро закончится."
    : observed.status === "scheduled" ? "Предзаказ такси принят."
    : `Такси: ${yandexTaxiStatusLabel(observed.status)}.`;
  return { finished: false, message, state };
}

/** The site's statuses (lavka.yandex.ru main bundle, read 26 October 2026) for an order without a title. */
const LAVKA_LABELS: Readonly<Record<string, string>> = {
  assembled: "заказ собран",
  assembling: "собираем заказ",
  canceled: "заказ отменён",
  closed: "заказ доставлен",
  created: "заказ принят",
  delivering: "курьер в пути",
  delivery_arrived: "курьер на месте",
  pending: "заказ ждёт подтверждения",
  performer_found: "курьер назначен",
};
const LAVKA_FINAL: ReadonlySet<string> = new Set(["canceled", "closed"]);
/** A just placed order: the person was told in the turn that placed it. */
const LAVKA_QUIET_FIRST: ReadonlySet<string> = new Set(["created", "pending"]);

export function decideLavkaWatch(
  previous: OrderWatchState | null,
  observed: LavkaObservation | null,
  options: { sinceStartMs: number },
): OrderWatchDecision {
  if (observed === null) {
    if (previous?.status === "gone" || LAVKA_FINAL.has(previous?.status ?? "")) return { finished: true, message: null, state: previous! };
    if (previous?.seen) {
      return { finished: true, message: "Лавка: заказа больше нет среди текущих, похоже, он доставлен или закрыт.", state: { ...previous, status: "gone" } };
    }
    return options.sinceStartMs < ORDER_WATCH_UNSEEN_GRACE_MS
      ? { finished: false, message: null, state: previous ?? { status: null } }
      : { finished: true, message: "Лавка: не вижу этот заказ среди текущих, перестаю следить.", state: { status: "gone" } };
  }
  const state: OrderWatchState = { seen: true, status: observed.status };
  const finished = LAVKA_FINAL.has(observed.status);
  if (finished && previous?.status === observed.status) return { finished: true, message: null, state };
  // No status yet: the first look, or a first message Telegram did not take (kept as not told).
  const quiet = observed.status === previous?.status || ((previous?.status ?? null) === null && LAVKA_QUIET_FIRST.has(observed.status));
  if (quiet && !finished) return { finished: false, message: null, state };
  const title = clip(observed.title) || LAVKA_LABELS[observed.status] || `статус «${clip(observed.status, 40)}»`;
  const subtitle = clip(observed.subtitle);
  return { finished, message: `Лавка: ${sentence(title)}${subtitle ? ` ${sentence(subtitle)}` : ""}`, state };
}

export function isFinalOrderState(service: "yandex_lavka" | "yandex_taxi", state: OrderWatchState | null): boolean {
  const status = state?.status ?? null;
  if (status === null) return false;
  return service === "yandex_taxi"
    ? status === "complete" || TAXI_FINAL[status] !== undefined
    : status === "gone" || LAVKA_FINAL.has(status);
}
