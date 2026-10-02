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
 */
import { createHash } from "node:crypto";

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
