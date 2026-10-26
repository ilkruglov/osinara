/**
 * A location shared in a private chat, as text the model can read.
 *
 * Export:
 * - `withLocationText`: fills the empty `text` of a private location or venue message with its
 *   coordinates (and the venue's name and address).
 *
 * Key construct:
 * - Telegram sends a shared location without text: the coordinates live only in `raw.location`,
 *   which Eve 0.40.0 does not read, so the model got an empty message and could not take the person
 *   to a taxi from where they stand (26 October 2026). Private chats only: there the person shares
 *   it with Mia for their own order; a group keeps its message as it was.
 */
import type { TelegramUpdate } from "eve/channels/telegram";

import { asRecord as record } from "./json-value.js";

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function locationLine(location: Record<string, unknown>): string | null {
  const latitude = coordinate(location.latitude, 90);
  const longitude = coordinate(location.longitude, 180);
  if (latitude === null || longitude === null) return null;
  const accuracy = coordinate(location.horizontal_accuracy, 1_500);
  const live = typeof location.live_period === "number" ? " (трансляция)" : "";
  return `Геолокация${live}: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}${accuracy === null ? "" : `, точность ${Math.round(accuracy)} м`}`;
}

function venueName(venue: Record<string, unknown>): string {
  return [venue.title, venue.address]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim().slice(0, 200))
    .join(", ");
}

export function withLocationText(update: TelegramUpdate): TelegramUpdate {
  if (update.kind !== "message" || update.message.chat.type !== "private") return update;
  if (update.message.text.trim() || update.message.caption.trim()) return update;
  const venue = record(update.message.raw.venue);
  const location = record(update.message.raw.location) ?? record(venue?.location);
  const line = location === null ? null : locationLine(location);
  if (line === null) return update;
  const name = venue === null ? "" : venueName(venue);
  const text = name ? `Место: ${name}. ${line}` : line;
  return { ...update, message: { ...update.message, text } };
}
