/**
 * Hashes and canonical text of JSON values.
 *
 * Exports:
 * - `sha256Json`: hex SHA-256 of `JSON.stringify(value)`, the form stored as operation and replay
 *   hashes across the repositories.
 * - `canonicalJson`: JSON with object keys sorted and undefined members dropped, for hashes that
 *   must not depend on key order.
 *
 * Key construct:
 * - Stored hashes keep plain `JSON.stringify`: rows already in the database were written with it,
 *   and a replay of an in-flight operation compares against them. Switching those to canonical
 *   JSON would turn every pending replay into a conflict.
 * - `canonicalJson` is the experiment protocol's legacy form, which stored hashes depend on: keys
 *   sorted, then put back into an object, where JavaScript orders integer-like keys first and
 *   numerically. Sorting the names as text broke those hashes (Codex review, 6 November 2026).
 */
import { createHash } from "node:crypto";

export function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "null";
}
