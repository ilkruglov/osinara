/**
 * Petrol stations with a given fuel near an address or a point.
 *
 * Export:
 * - `find_fuel_stations`: per-grade status and prices from Яндекс Карты; the address is geocoded
 *   through OpenStreetMap. When Яндекс cannot answer, the tool fails and says so.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { FUEL_MAP_MAX_RADIUS_METERS, FUEL_TYPES, formatFuelStations, geocodeAddress } from "../fuel/fuel-map.js";
import { yandexFuel } from "../fuel/yandex-fuel.js";
import { requireMemoryAuthorization } from "../memory-context.js";

const inputSchema = z.object({
  address: z.string().trim().min(3).max(200).optional(),
  fuel: z.enum(FUEL_TYPES),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusMeters: z.number().int().min(500).max(FUEL_MAP_MAX_RADIUS_METERS).optional(),
}).strict().superRefine((value, ctx) => {
  const point = value.lat !== undefined && value.lng !== undefined;
  if (!point && !value.address) ctx.addIssue({ code: "custom", message: "Нужен address или пара lat и lng" });
  if ((value.lat === undefined) !== (value.lng === undefined)) ctx.addIssue({ code: "custom", message: "lat и lng задаются вместе" });
});

export default defineTool({
  description: [
    "Заправки рядом, где сейчас есть нужное топливо: fuel AI_92|AI_95|AI_98|AI_100|DT|GAS, address (город и улица) или lat+lng, radiusMeters до 30000 (по умолчанию 5000).",
    "Источник — Яндекс Карты: статус по марке из оплат на колонке (есть / закончилось / неточно / нет данных), цены, очередь, лимит, давность сигнала. Если Яндекс не ответил, инструмент возвращает ошибку: скажи об этом человеку, других источников нет.",
    "В ответе до 10 АЗС: сначала где есть, потом ближе. Назови давность сигнала, не выдавай «есть» за гарантию.",
  ].join(" "),
  inputSchema,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    if (auth.role === "external") throw new Error("AGENT_FUEL_MAP_FORBIDDEN: Поиск заправок доступен только в семейных чатах");
    const point = input.lat !== undefined && input.lng !== undefined
      ? { label: null, lat: input.lat, lng: input.lng }
      : await geocodeAddress(input.address!);
    const radiusMeters = input.radiusMeters ?? 5_000;
    const stations = await yandexFuel({ fuel: input.fuel, lat: point.lat, lng: point.lng, radiusMeters });
    return { origin: point.label ?? `${point.lat}, ${point.lng}`, radiusMeters, source: "Яндекс Карты", stations: formatFuelStations(stations, input.fuel), total: stations.length };
  },
});
