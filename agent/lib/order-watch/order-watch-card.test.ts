/**
 * The live card of a watched order.
 *
 * Constructs covered:
 * - The card data is a short JSON (within Telegram's 1024-byte state, counted in UTF-8 after
 *   escaping, control characters dropped) with the order's status, car, plates, driver, minutes,
 *   cost or the shop's own title; the driver's name is drawn next to the car.
 * - The card HTML passes the same widget check Mia's cards pass, fits the size budget, carries the
 *   first state inside so it shows before any edit, and cannot be broken by text from the site.
 */
import { describe, expect, it } from "vitest";

import { measureTelegramWidget } from "../telegram-widgets/telegram-widget-limits.js";
import { lintTelegramWidget } from "../telegram-widgets/telegram-widget-lint.js";
import { orderCardData, orderCardHtml } from "./order-watch-card.js";

const now = new Date("2026-11-06T12:00:00Z");

/** What the card's own script writes into its elements, run against a minimal page. */
function rendered(html: string): Record<string, string> {
  const script = /<script>([\s\S]*)<\/script>/u.exec(html)![1]!;
  const nodes: Record<string, { appendChild(node: unknown): void; className: string; textContent: string }> = {};
  const page = {
    createElement: () => ({ className: "" }),
    getElementById: (id: string) => (nodes[id] ??= { appendChild() {}, className: "", textContent: "" }),
  };
  // oxlint-disable-next-line typescript/no-implied-eval -- the card's fixed script is run to see what it draws
  new Function("document", "window", script)(page, {});
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, node.textContent]));
}

describe("order watch card", () => {
  it("packs a taxi look into a short state and clips what the site returns", () => {
    const data = orderCardData({ service: "yandex_taxi", taxi: {
      car: "Kia Rio белый", driver: "Иван", finalCost: null, minutesLeft: 4, plates: "А123ВВ777", status: "driving",
    } }, now);
    expect(JSON.parse(data)).toEqual({ c: "Kia Rio белый", d: "Иван", k: "taxi", m: 4, p: "А123ВВ777", s: "driving", t: 1_793_966_400 });
    const long = orderCardData({ service: "yandex_lavka", lavka: { status: "delivering", subtitle: "я".repeat(5_000), title: "Курьер в пути" } }, now);
    expect(Buffer.byteLength(long)).toBeLessThan(1_024);
  });

  it("renders a card that passes the widget check, fits the budget and shows its first state", () => {
    for (const service of ["yandex_taxi", "yandex_lavka"] as const) {
      const data = service === "yandex_taxi"
        ? orderCardData({ service, taxi: { car: null, driver: null, finalCost: null, minutesLeft: null, plates: null, status: "search" } }, now)
        : orderCardData({ lavka: { status: "assembling", subtitle: "Будет к 14:30", title: "Собираем заказ" }, service }, now);
      const html = orderCardHtml(service, data);
      expect(lintTelegramWidget(html, { allowLinks: false })).toEqual({ errors: [], links: [], warnings: [] });
      expect(measureTelegramWidget(html).compressedBytes).toBeLessThan(2_048);
      expect(html).toContain(data.replace(/</gu, "\\u003c"));
    }
  });

  // Codex review of 1.8.55: limits by characters before JSON escaping overflowed 1 024 bytes.
  it("keeps the state within 1 024 bytes whatever the site returns", () => {
    for (const fill of ["\u0001", "😀", "я"]) {
      const data = orderCardData({ lavka: { status: fill.repeat(40), subtitle: fill.repeat(500), title: fill.repeat(500) }, service: "yandex_lavka" }, now);
      expect(Buffer.byteLength(data), JSON.stringify(fill)).toBeLessThanOrEqual(1_024);
      expect(data).not.toContain("\\u0001");
    }
  });

  it("shows the driver's name next to the car", () => {
    const data = orderCardData({ service: "yandex_taxi", taxi: {
      car: "Kia Rio белый", driver: "Иван", finalCost: null, minutesLeft: 4, plates: "А123ВВ777", status: "driving",
    } }, now);
    expect(rendered(orderCardHtml("yandex_taxi", data)).x).toBe("Kia Rio белый · А123ВВ777 · Иван · через 4 мин");
  });

  it("keeps text from the site from closing the script", () => {
    const data = orderCardData({ lavka: { status: "delivering", subtitle: "</script><img src=x>", title: "Курьер" }, service: "yandex_lavka" }, now);
    const html = orderCardHtml("yandex_lavka", data);
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
  });
});
