/**
 * Fuel shape tests.
 *
 * Constructs covered:
 * - Stations sort available first, then nearest; the rows carry labels, distance and the age of
 *   the last signal.
 * - The address geocoder returns the first match and names a miss.
 */
import { describe, expect, it, vi } from "vitest";

import { distanceMeters, formatFuelStations, type FuelStation, geocodeAddress, sortFuelStations } from "./fuel-map.js";

const station = (address: string, availability: FuelStation["availability"], distance: number, extra: Partial<FuelStation> = {}): FuelStation => ({
  address, availability, brand: "Лукойл", distanceMeters: distance, fuels: ["AI_100", "DT"], lastReportAt: "2026-09-26T05:30:00Z",
  limitLiters: null, limitText: null, name: "Лукойл, АЗС", priceRub: null, queue: null, reports: 0, ...extra,
});
const fetchWith = (status: number, payload: unknown) => vi.fn(async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;

describe("fuel stations", () => {
  it("sorts available first, then nearest, and formats the rows", () => {
    const sorted = sortFuelStations([
      station("Далёкая", "available", 6_000, { priceRub: 99.4, queue: "без очереди", reports: 12 }),
      station("Кончилось", "out", 300, { lastReportAt: "2026-09-26T04:00:00Z" }),
      station("Ближняя", "available", 80, { limitText: "до 30 л" }),
      station("Неизвестно", "unknown", 200, { lastReportAt: null }),
    ]);
    expect(sorted.map((s) => s.address)).toEqual(["Ближняя", "Далёкая", "Неизвестно", "Кончилось"]);
    expect(distanceMeters({ lat: 55.7558, lng: 37.6173 }, { lat: 55.80, lng: 37.70 })).toBeGreaterThan(6_000);
    const rows = formatFuelStations(sorted, "AI_100", new Date("2026-09-26T06:00:00Z"));
    expect(rows[0]).toMatchObject({ distanceKm: 0.1, fuel: "АИ-100", lastSignal: "30 мин назад", limit: "до 30 л", name: "Лукойл", otherFuels: ["ДТ"], status: "есть" });
    expect(rows[1]).toMatchObject({ priceRub: 99.4, queue: "без очереди", signals: 12 });
    expect(rows[2]).toMatchObject({ lastSignal: "сигналов нет", status: "нет данных" });
    expect(rows[3]).toMatchObject({ lastSignal: "2 ч назад", status: "закончилось" });
  });

  it("geocodes an address and names a miss", async () => {
    const hit = fetchWith(200, [{ display_name: "12, Мещанская улица, Москва", lat: "55.7763", lon: "37.6279" }]);
    await expect(geocodeAddress("Москва, Мещанская 12", hit)).resolves.toEqual({ label: "12, Мещанская улица, Москва", lat: 55.7763, lng: 37.6279 });
    expect(String((hit as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain("nominatim.openstreetmap.org");
    await expect(geocodeAddress("нигде", fetchWith(200, []))).rejects.toMatchObject({ code: "AGENT_GEOCODER_NOT_FOUND" });
  });
});
