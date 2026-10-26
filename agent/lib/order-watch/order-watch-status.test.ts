/**
 * Order watch decisions: what the person is told when an order moves on.
 *
 * Constructs covered:
 * - A taxi tells about the car found, a changed car, the car arriving, the ride and its end; the
 *   search, the minutes ticking down and a status seen again say nothing.
 * - Every final taxi status ends the watch with its own words.
 * - Lavka speaks the site's own status title, falls back to its own words, ends on a delivered or
 *   cancelled order, and waits a while for a new order to appear among the tracked ones.
 * - An end already told (the message went, ending the watch did not) ends quietly the next time.
 */
import { describe, expect, it } from "vitest";

import { decideLavkaWatch, decideTaxiWatch, type TaxiObservation } from "./order-watch-status.js";

const taxi = (status: string, extra: Partial<TaxiObservation> = {}): TaxiObservation => ({
  car: null, driver: null, finalCost: null, minutesLeft: null, plates: null, status, ...extra,
});

describe("decideTaxiWatch", () => {
  it("stays quiet while a car is searched for and speaks once it is found", () => {
    const searching = decideTaxiWatch(null, taxi("search"));
    expect(searching).toMatchObject({ finished: false, message: null });
    const found = decideTaxiWatch(searching.state, taxi("driving", { car: "Белый Kia Rio", driver: "Иван", minutesLeft: 6, plates: "А123ВС777" }));
    expect(found.message).toBe("Такси едет: Белый Kia Rio, А123ВС777, водитель Иван, будет через 6 мин.");
    expect(decideTaxiWatch(found.state, taxi("driving", { car: "Белый Kia Rio", minutesLeft: 3, plates: "А123ВС777" })).message).toBeNull();
  });

  it("names a new car when the driver changes on the way", () => {
    const first = decideTaxiWatch(null, taxi("driving", { car: "Белый Kia Rio", plates: "А123ВС777" }));
    expect(decideTaxiWatch(first.state, taxi("driving", { car: "Серый Škoda Octavia", minutesLeft: 9, plates: "М456ОР799" })).message)
      .toBe("Сменилась машина: Серый Škoda Octavia, М456ОР799, будет через 9 мин.");
  });

  it("tells about the car on the spot once, however Yandex Go names the waiting", () => {
    const waiting = decideTaxiWatch({ car: "Белый Kia Rio", plates: "А123ВС777", status: "driving" }, taxi("waiting", { car: "Белый Kia Rio", plates: "А123ВС777" }));
    expect(waiting.message).toBe("Такси на месте: Белый Kia Rio, А123ВС777.");
    expect(decideTaxiWatch(waiting.state, taxi("calling", { car: "Белый Kia Rio", plates: "А123ВС777" })).message).toBeNull();
    expect(decideTaxiWatch(waiting.state, taxi("transporting")).message).toBe("Поездка началась.");
  });

  it.each([
    ["complete", { finalCost: "540 ₽" }, "Поездка завершена, стоимость 540 ₽."],
    ["cancelled", {}, "Заказ такси отменён."],
    ["expired", {}, "Яндекс Go не нашёл машину, заказ закрыт."],
    ["failed", {}, "Заказ такси не выполнен."],
  ] as const)("ends the watch on %s", (status, extra, message) => {
    expect(decideTaxiWatch({ status: "transporting" }, taxi(status, extra))).toMatchObject({ finished: true, message });
  });

  it("does not tell the end of a ride twice", () => {
    expect(decideTaxiWatch({ status: "complete" }, taxi("complete", { finalCost: "540 ₽" }))).toMatchObject({ finished: true, message: null });
    expect(decideTaxiWatch({ status: "cancelled" }, taxi("cancelled"))).toMatchObject({ finished: true, message: null });
  });

  it("warns before the search runs out and names an unknown status by the site's code", () => {
    expect(decideTaxiWatch({ status: "search" }, taxi("preexpired")).message).toBe("Машину пока не нашли, поиск скоро закончится.");
    expect(decideTaxiWatch({ status: "search" }, taxi("rerouting")).message).toBe("Такси: статус Яндекс Go «rerouting».");
  });
});

describe("decideLavkaWatch", () => {
  const fresh = { sinceStartMs: 60_000 };

  it("says nothing about a just placed order and speaks the site's title on every new status", () => {
    const placed = decideLavkaWatch(null, { status: "created", subtitle: "", title: "Заказ принят" }, fresh);
    expect(placed).toMatchObject({ finished: false, message: null, state: { seen: true, status: "created" } });
    const courier = decideLavkaWatch(placed.state, { status: "delivering", subtitle: "Будет через 7 минут.", title: "Курьер в пути" }, fresh);
    expect(courier.message).toBe("Лавка: Курьер в пути. Будет через 7 минут.");
    expect(decideLavkaWatch(courier.state, { status: "delivering", subtitle: "Будет через 3 минуты", title: "Курьер в пути" }, fresh).message).toBeNull();
    expect(decideLavkaWatch(courier.state, { status: "delivery_arrived", subtitle: "", title: "" }, fresh).message).toBe("Лавка: курьер на месте.");
  });

  it("ends on a delivered or cancelled order", () => {
    expect(decideLavkaWatch({ seen: true, status: "delivering" }, { status: "closed", subtitle: "", title: "" }, fresh))
      .toMatchObject({ finished: true, message: "Лавка: заказ доставлен." });
    expect(decideLavkaWatch({ seen: true, status: "assembling" }, { status: "canceled", subtitle: "", title: "Заказ отменён" }, fresh))
      .toMatchObject({ finished: true, message: "Лавка: Заказ отменён." });
  });

  it("waits for a new order to appear, then gives up, and ends when a seen order leaves the list", () => {
    expect(decideLavkaWatch(null, null, fresh)).toMatchObject({ finished: false, message: null });
    expect(decideLavkaWatch(null, null, { sinceStartMs: 11 * 60_000 }))
      .toMatchObject({ finished: true, message: "Лавка: не вижу этот заказ среди текущих, перестаю следить." });
    expect(decideLavkaWatch({ seen: true, status: "delivering" }, null, fresh))
      .toMatchObject({ finished: true, message: "Лавка: заказа больше нет среди текущих, похоже, он доставлен или закрыт.", state: { seen: true, status: "gone" } });
  });

  it("does not tell the end of an order twice", () => {
    expect(decideLavkaWatch({ seen: true, status: "gone" }, null, fresh)).toMatchObject({ finished: true, message: null });
    expect(decideLavkaWatch({ status: "gone" }, null, { sinceStartMs: 11 * 60_000 })).toMatchObject({ finished: true, message: null });
    expect(decideLavkaWatch({ seen: true, status: "closed" }, { status: "closed", subtitle: "", title: "" }, fresh)).toMatchObject({ finished: true, message: null });
    expect(decideLavkaWatch({ seen: true, status: "closed" }, null, fresh)).toMatchObject({ finished: true, message: null });
  });
});
