/**
 * Fuel availability at petrol stations: the shared shape, the geocoder and the rows for the model.
 *
 * Exports:
 * - `FUEL_TYPES`, `FuelType`, `FuelStation`, `FuelAvailability`: the grades and one station.
 * - `sortFuelStations`, `distanceMeters`, `text`: helpers shared with the source.
 * - `geocodeAddress`: an address to coordinates through OpenStreetMap Nominatim.
 * - `formatFuelStations`: the model-facing rows.
 *
 * Key constructs:
 * - One source, Яндекс Карты (`yandex-fuel.ts`): status per grade from payments at the pump.
 *   When it cannot answer, the tool says so; no second source stands in for it (owner's rule,
 *   26 сентября 2026: a broken source is a broken source, not an occasion to answer something).
 *   The 2ГИС fuel map was tried and dropped: it infers availability from bank transactions and
 *   reports and showed "available" on a report a week old.
 * - Nominatim asks for a User-Agent and one request per second; a family asks far less. Only the
 *   address text leaves the server.
 */
import { AppError } from "../app-error.js";

export const FUEL_TYPES = ["AI_92", "AI_95", "AI_98", "AI_100", "DT", "GAS"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];
const FUEL_LABELS: Record<FuelType, string> = { AI_100: "АИ-100", AI_92: "АИ-92", AI_95: "АИ-95", AI_98: "АИ-98", DT: "ДТ", GAS: "газ" };

export const FUEL_MAP_MAX_RADIUS_METERS = 30_000;
export const FUEL_MAP_MAX_RESULTS = 10;
const FUEL_MAP_TIMEOUT_MS = 15_000;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Osinara family bot (https://github.com/ilkruglov/osinara)";

/** `available` is a payment or a report saying so; `uncertain` is a source that doubts itself. */
export type FuelAvailability = "available" | "out" | "uncertain" | "unknown";
const AVAILABILITY_RANK: Record<FuelAvailability, number> = { available: 0, uncertain: 1, unknown: 2, out: 3 };

export interface FuelStation {
  readonly address: string;
  readonly availability: FuelAvailability;
  readonly brand: string;
  readonly distanceMeters: number;
  readonly fuels: FuelType[];
  readonly lastReportAt: string | null;
  readonly limitLiters: number | null;
  readonly limitText: string | null;
  readonly name: string;
  readonly priceRub: number | null;
  readonly queue: string | null;
  readonly reports: number;
}

/** Great-circle distance in metres, enough to sort stations within a city. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.asin(Math.sqrt(h)));
}

export function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replaceAll(/\s+/gu, " ").trim().slice(0, limit) : "";
}

export function sortFuelStations(stations: FuelStation[]): FuelStation[] {
  return stations.sort((a, b) => AVAILABILITY_RANK[a.availability] - AVAILABILITY_RANK[b.availability] || a.distanceMeters - b.distanceMeters);
}


export async function geocodeAddress(address: string, fetchImplementation: typeof fetch = (input, init) => fetch(input, init)): Promise<{ label: string; lat: number; lng: number }> {
  const query = new URLSearchParams({ "accept-language": "ru", countrycodes: "ru", format: "jsonv2", limit: "1", q: address });
  let response: Response;
  try {
    response = await fetchImplementation(`${NOMINATIM_URL}?${query.toString()}`, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FUEL_MAP_TIMEOUT_MS) });
  } catch (error) {
    console.error(JSON.stringify({ code: "AGENT_GEOCODER_UNAVAILABLE", diagnostic: error instanceof Error ? error.name : "UnknownError" }));
    throw new AppError("AGENT_GEOCODER_UNAVAILABLE", "Не удалось определить координаты адреса. Попробуйте позже");
  }
  if (!response.ok) throw new AppError("AGENT_GEOCODER_UNAVAILABLE", "Не удалось определить координаты адреса. Попробуйте позже");
  const body = await response.json().catch(() => null) as { display_name?: unknown; lat?: unknown; lon?: unknown }[] | null;
  const first = Array.isArray(body) ? body[0] : undefined;
  const lat = Number(first?.lat); const lng = Number(first?.lon);
  if (!first || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new AppError("AGENT_GEOCODER_NOT_FOUND", "Такой адрес не нашёлся. Уточните город и улицу");
  return { label: text(first.display_name, 160), lat, lng };
}

const AVAILABILITY_LABELS: Record<FuelAvailability, string> = { available: "есть", out: "закончилось", uncertain: "неточно", unknown: "нет данных" };

/** Rows for the model: the person reads a list, not a table of enum values. */
export function formatFuelStations(stations: FuelStation[], fuel: FuelType, now = new Date()) {
  return stations.slice(0, FUEL_MAP_MAX_RESULTS).map((s) => {
    const age = s.lastReportAt === null ? null : Math.round((now.getTime() - Date.parse(s.lastReportAt)) / 60_000);
    return {
      address: s.address,
      distanceKm: Number((s.distanceMeters / 1000).toFixed(1)),
      fuel: FUEL_LABELS[fuel],
      lastSignal: age === null ? "сигналов нет" : age < 60 ? `${age} мин назад` : `${Math.round(age / 60)} ч назад`,
      name: s.brand || s.name,
      otherFuels: s.fuels.filter((f) => f !== fuel).map((f) => FUEL_LABELS[f]),
      status: AVAILABILITY_LABELS[s.availability],
      ...(s.priceRub === null ? {} : { priceRub: s.priceRub }),
      ...(s.limitText === null ? {} : { limit: s.limitText }),
      ...(s.queue === null ? {} : { queue: s.queue }),
      ...(s.reports === 0 ? {} : { signals: s.reports }),
    };
  });
}
