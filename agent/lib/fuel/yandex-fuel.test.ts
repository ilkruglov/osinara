/**
 * Яндекс fuel source tests.
 *
 * Constructs covered:
 * - The embedded search state is parsed; a captcha page or a page without it is a named error.
 * - A station reports the requested grade's status, its price, the signal age and the queue.
 * - Stations outside the radius or without the grade are dropped; the zoom follows the radius.
 */
import { describe, expect, it, vi } from "vitest";

import { formatFuelStations } from "./fuel-map.js";
import { createYandexFuel, parseYandexMapsState, zoomForRadius } from "./yandex-fuel.js";

const station = (title: string, lng: number, lat: number, fuel: Record<string, unknown>[], prices: Record<string, unknown>[] = []) => ({
  address: `${title}, Москва`, coordinates: [lng, lat],
  fuelAvailability: { fuel, lastSignalTimestamp: 1_790_393_669, localizedFuelLimit: "до 40 л", queueStatus: "NONE", signalsCountPerHour: 3, status: "IN_STOCK" },
  fuelInfo: { items: prices, source: { name: "MultiGo" }, timestamp: 1_790_110_800 }, title,
});
const items = [
  station("Лукойл", 37.6227, 55.7839, [{ fuelType: "AI100", status: "IN_STOCK" }, { fuelType: "DIESEL", status: "OUT_OF_STOCK" }], [{ name: "АИ 100", price: { value: 99.4 } }, { name: "ДТ+", price: { value: 80.42 } }]),
  station("Нефтьмагистраль", 37.6190, 55.7570, [{ fuelType: "AI100", status: "UNCERTAIN" }, { fuelType: "AI95", status: "OUT_OF_STOCK" }, { fuelType: "AI95_PREMIUM", status: "IN_STOCK" }], [{ name: "АИ 95", price: { value: 101 } }, { name: "АИ 95+", price: { value: 104 } }]),
  station("Без сотого", 37.6180, 55.7560, [{ fuelType: "AI95", status: "IN_STOCK" }]),
  station("Газ по прайсу", 37.6185, 55.7565, [{ fuelType: "AI92", status: "IN_STOCK" }], [{ name: "Газ", price: { value: 30.5 } }]),
  station("Далеко", 38.2, 56.1, [{ fuelType: "AI100", status: "IN_STOCK" }]),
];
const page = (state: unknown) => `<html><head><script type="application/json" data-state="x">${JSON.stringify(state)}</script></head><body></body></html>`;
const fetchWith = (html: string, status = 200) => vi.fn(async () => new Response(html, { status })) as unknown as typeof fetch;

describe("yandex fuel", () => {
  it("parses the search state and refuses a captcha or a foreign page", () => {
    expect(parseYandexMapsState(page({ stack: [{ results: { items } }] }))).toHaveLength(5);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => parseYandexMapsState("<html>showcaptcha</html>")).toThrow(/AGENT_YANDEX_FUEL_UNAVAILABLE/u);
    expect(() => parseYandexMapsState("<html><script type=\"application/json\">{}</script></html>")).toThrow(/AGENT_YANDEX_FUEL_UNAVAILABLE/u);
    error.mockRestore();
  });

  it("reports the grade's status, price and signal, nearest and available first, within the radius", async () => {
    const fetch = fetchWith(page({ stack: [{ results: { items } }] }));
    const nearby = createYandexFuel({ fetch, url: "https://maps.test/" });
    const found = await nearby({ fuel: "AI_100", lat: 55.7558, lng: 37.6173, radiusMeters: 5000 });
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain("ll=37.6173%2C55.7558&text=%D0%90%D0%97%D0%A1&z=14");
    expect(found.map((s) => s.brand)).toEqual(["Лукойл", "Нефтьмагистраль"]);
    expect(found[0]).toMatchObject({ availability: "available", fuels: ["AI_100", "DT"], limitText: "до 40 л", priceRub: 99.4, queue: "без очереди", reports: 3 });
    expect(found[1]).toMatchObject({ availability: "uncertain", priceRub: null });
    const rows = formatFuelStations(found, "AI_100", new Date(1_790_393_669_000 + 25 * 60_000));
    expect(rows[0]).toMatchObject({ lastSignal: "25 мин назад", limit: "до 40 л", priceRub: 99.4, status: "есть" });
    expect(rows[1]).toMatchObject({ status: "неточно" });
  });

  it("prices the reported variant and lists a grade sold only by the price list as unknown", async () => {
    const nearby = createYandexFuel({ fetch: fetchWith(page({ stack: [{ results: { items } }] })), url: "https://maps.test/" });
    const premium = await nearby({ fuel: "AI_95", lat: 55.7558, lng: 37.6173, radiusMeters: 5000 });
    // Regular 95 is out at 101 ₽ and 95+ is in stock at 104 ₽: the answer is 95+ at 104, never 101.
    expect(premium.find((s) => s.brand === "Нефтьмагистраль")).toMatchObject({ availability: "available", priceRub: 104 });
    const gas = await nearby({ fuel: "GAS", lat: 55.7558, lng: 37.6173, radiusMeters: 5000 });
    expect(gas.map((s) => [s.brand, s.availability, s.priceRub])).toEqual([["Газ по прайсу", "unknown", 30.5]]);
  });

  it("names a failing page", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createYandexFuel({ fetch: fetchWith("", 302), url: "https://maps.test/" })({ fuel: "DT", lat: 1, lng: 1, radiusMeters: 1000 })).rejects.toMatchObject({ code: "AGENT_YANDEX_FUEL_UNAVAILABLE" });
    expect([zoomForRadius(2000), zoomForRadius(5000), zoomForRadius(10000), zoomForRadius(30000)]).toEqual([15, 14, 13, 12]);
    error.mockRestore();
  });
});
