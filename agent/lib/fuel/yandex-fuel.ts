/**
 * Fuel availability from Яндекс Карты, the primary source.
 *
 * Exports:
 * - `createYandexFuel` / `yandexFuel`: stations around a point with the status of one grade.
 * - `parseYandexMapsState`: the search state embedded in the page, for tests.
 *
 * Key constructs:
 * - The search page `yandex.ru/maps/?text=АЗС&ll=<lng>,<lat>&z=<zoom>` embeds its results as
 *   JSON: for every station `fuelAvailability.fuel[]` with a status per grade (IN_STOCK,
 *   OUT_OF_STOCK, UNCERTAIN, UNKNOWN) built from payments at the pump, the time and rate of the
 *   last signals, a queue status and a litre limit, and `fuelInfo` with prices (MultiGo). This is
 *   what the owner trusts.
 * - It is a page, not an API: one request per call, browser headers, never retried, and a captcha
 *   or a changed page is `AGENT_YANDEX_FUEL_UNAVAILABLE`: the person hears that Яндекс did not
 *   answer, nothing stands in for it.
 * - The zoom follows the radius: 14 covers about 6 km, each step down doubles it.
 */
import { AppError } from "../app-error.js";
import { type FuelAvailability, type FuelStation, type FuelType, FUEL_TYPES, distanceMeters, sortFuelStations, text } from "./fuel-map.js";

export const YANDEX_MAPS_URL = process.env.YANDEX_MAPS_URL ?? "https://yandex.ru/maps/";
const TIMEOUT_MS = 20_000;
const YANDEX_GRADES: Record<FuelType, string[]> = {
  AI_100: ["AI100"], AI_92: ["AI92", "AI92_PREMIUM"], AI_95: ["AI95", "AI95_PREMIUM"], AI_98: ["AI98", "AI98_PREMIUM"], DT: ["DIESEL", "DIESEL_PREMIUM"], GAS: ["GAS", "LPG", "PROPANE", "METHANE"],
};
/** Price rows are named «АИ 95» for the regular grade and «АИ 95+» for the premium one. */
const PRICE_NAMES: Record<FuelType, { premium: RegExp; regular: RegExp }> = {
  AI_100: { premium: /^аи[\s-]?100\s*\+/iu, regular: /^аи[\s-]?100(?!\s*\+)/iu },
  AI_92: { premium: /^аи[\s-]?92\s*\+/iu, regular: /^аи[\s-]?92(?!\s*\+)/iu },
  AI_95: { premium: /^аи[\s-]?95\s*\+/iu, regular: /^аи[\s-]?95(?!\s*\+)/iu },
  AI_98: { premium: /^аи[\s-]?98\s*\+/iu, regular: /^аи[\s-]?98(?!\s*\+)/iu },
  DT: { premium: /^дт\s*\+/iu, regular: /^дт(?!\s*\+)/iu },
  GAS: { premium: /(?!)/u, regular: /газ|спбт|пропан|метан/iu },
};
type Variant = "premium" | "regular";
const STATUS: Record<string, FuelAvailability> = { IN_STOCK: "available", OUT_OF_STOCK: "out", UNCERTAIN: "uncertain", UNKNOWN: "unknown" };
const QUEUE: Record<string, string> = { LONG: "очередь большая", MEDIUM: "очередь средняя", NONE: "без очереди", SHORT: "очередь небольшая" };

function unavailable(diagnostic: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_YANDEX_FUEL_UNAVAILABLE", diagnostic }));
  return new AppError("AGENT_YANDEX_FUEL_UNAVAILABLE", "Яндекс Карты сейчас не отвечают, данных о заправках нет. Попробуйте позже");
}

export function zoomForRadius(radiusMeters: number): number {
  if (radiusMeters <= 3_000) return 15;
  if (radiusMeters <= 6_000) return 14;
  if (radiusMeters <= 12_000) return 13;
  return 12;
}

export function parseYandexMapsState(html: string): Record<string, unknown>[] {
  if (/showcaptcha|SmartCaptcha/u.test(html)) throw unavailable("captcha");
  for (const match of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gu)) {
    const raw = match[1] ?? "";
    if (!raw.includes('"stack"')) continue;
    try {
      const state = JSON.parse(raw) as { stack?: { results?: { items?: unknown } }[] };
      const items = state.stack?.[0]?.results?.items;
      if (Array.isArray(items)) return items as Record<string, unknown>[];
    } catch { /* not the state script */ }
  }
  throw unavailable("state_missing");
}

const RANK = ["available", "uncertain", "unknown", "out"] as const;

/** The best-status variant of the grade; the price is then read for that same variant. */
function gradeOf(item: Record<string, unknown>, fuel: FuelType): { availability: FuelAvailability; present: boolean; variant: Variant } {
  const availability = item.fuelAvailability as { fuel?: unknown } | undefined;
  const rows = Array.isArray(availability?.fuel) ? availability.fuel as { fuelType?: unknown; status?: unknown }[] : [];
  const wanted = YANDEX_GRADES[fuel];
  const matches = rows
    .filter((row): row is { fuelType: string; status?: unknown } => typeof row.fuelType === "string" && wanted.includes(row.fuelType))
    .map((row) => ({ availability: STATUS[String(row.status)] ?? "unknown", variant: (row.fuelType.endsWith("_PREMIUM") ? "premium" : "regular") as Variant }));
  if (matches.length === 0) {
    // Sold by the price list but not reported: the grade is on sale with no availability signal.
    const priced = priceRows(item).some((row) => PRICE_NAMES[fuel].regular.test(row.name) || PRICE_NAMES[fuel].premium.test(row.name));
    return { availability: "unknown", present: priced, variant: "regular" };
  }
  const best = matches.sort((a, b) => RANK.indexOf(a.availability) - RANK.indexOf(b.availability))[0]!;
  return { availability: best.availability, present: true, variant: best.variant };
}

function priceRows(item: Record<string, unknown>): { name: string; value: number | null }[] {
  const info = item.fuelInfo as { items?: unknown } | undefined;
  const rows = Array.isArray(info?.items) ? info.items as { name?: unknown; price?: { value?: unknown } }[] : [];
  return rows
    .filter((entry): entry is { name: string; price?: { value?: unknown } } => typeof entry.name === "string")
    .map((entry) => ({ name: entry.name.trim(), value: typeof entry.price?.value === "number" && Number.isFinite(entry.price.value) && entry.price.value > 0 ? entry.price.value : null }));
}

function fuelsOf(item: Record<string, unknown>): FuelType[] {
  const availability = item.fuelAvailability as { fuel?: unknown } | undefined;
  const rows = Array.isArray(availability?.fuel) ? availability.fuel as { fuelType?: unknown }[] : [];
  const prices = priceRows(item);
  return FUEL_TYPES.filter((type) =>
    rows.some((row) => typeof row.fuelType === "string" && YANDEX_GRADES[type].includes(row.fuelType))
    || prices.some((row) => PRICE_NAMES[type].regular.test(row.name) || PRICE_NAMES[type].premium.test(row.name)));
}

/** The price of the variant whose status is reported; no matching row means no price, never a neighbour's. */
function priceOf(item: Record<string, unknown>, fuel: FuelType, variant: Variant): number | null {
  return priceRows(item).find((row) => PRICE_NAMES[fuel][variant].test(row.name))?.value ?? null;
}

export function createYandexFuel(dependencies: { fetch: typeof fetch; url: string }) {
  return async function nearby(input: { fuel: FuelType; lat: number; lng: number; radiusMeters: number }): Promise<FuelStation[]> {
    const query = new URLSearchParams({ ll: `${input.lng},${input.lat}`, text: "АЗС", z: String(zoomForRadius(input.radiusMeters)) });
    let html: string;
    try {
      const response = await dependencies.fetch(`${dependencies.url}?${query.toString()}`, {
        headers: { accept: "text/html", "accept-language": "ru,en;q=0.9", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw unavailable(`status_${response.status}`);
      html = await response.text();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable(error instanceof Error ? error.name : "UnknownError");
    }
    const stations: FuelStation[] = [];
    for (const item of parseYandexMapsState(html)) {
      const coordinates = item.coordinates;
      if (!Array.isArray(coordinates) || typeof coordinates[0] !== "number" || typeof coordinates[1] !== "number") continue;
      const grade = gradeOf(item, input.fuel);
      if (!grade.present) continue;
      const distance = distanceMeters({ lat: input.lat, lng: input.lng }, { lat: coordinates[1], lng: coordinates[0] });
      if (distance > input.radiusMeters) continue;
      const availability = item.fuelAvailability as { lastSignalTimestamp?: unknown; localizedFuelLimit?: unknown; queueStatus?: unknown; signalsCountPerHour?: unknown } | undefined;
      const limit = text(availability?.localizedFuelLimit, 60);
      stations.push({
        address: text(item.address, 160),
        availability: grade.availability,
        brand: text(item.title, 60),
        distanceMeters: distance,
        fuels: fuelsOf(item),
        lastReportAt: typeof availability?.lastSignalTimestamp === "number" ? new Date(availability.lastSignalTimestamp * 1_000).toISOString() : null,
        limitLiters: null,
        limitText: limit || null,
        name: text(item.title, 80),
        priceRub: priceOf(item, input.fuel, grade.variant),
        queue: typeof availability?.queueStatus === "string" ? QUEUE[availability.queueStatus] ?? null : null,
        reports: typeof availability?.signalsCountPerHour === "number" ? availability.signalsCountPerHour : 0,
      });
    }
    return sortFuelStations(stations);
  };
}

export const yandexFuel = createYandexFuel({ fetch: (input, init) => fetch(input, init), url: YANDEX_MAPS_URL });
