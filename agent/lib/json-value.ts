/**
 * Narrowing untyped JSON from providers, Telegram and stored payloads.
 *
 * Exports:
 * - `isRecord`: a plain object (not null, not an array), as a type guard.
 * - `asRecord`: the same object, or null.
 * - `nonEmptyText`: a trimmed non-empty string, or null.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}
