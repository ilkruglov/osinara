/**
 * JSON hash contract tests.
 *
 * Constructs covered:
 * - `sha256Json` stays byte-compatible with hashes already stored by the repositories.
 * - `canonicalJson` ignores key order and matches the protocol hash written before the merge.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Json } from "./json-hash.js";

/** The canonical form the experiment repository used before this module existed. */
function legacyCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, legacyCanonical(v)]));
  }
  return value;
}

const sample = { b: [1, { z: "я", a: null }, undefined], a: { c: true, b: undefined }, n: 1.5 };

describe("json hashes", () => {
  it("hashes plain JSON.stringify exactly as stored rows were written", () => {
    expect(sha256Json(sample)).toBe(createHash("sha256").update(JSON.stringify(sample)).digest("hex"));
  });

  it("ignores key order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("matches the legacy canonical form byte for byte", () => {
    expect(canonicalJson(sample)).toBe(JSON.stringify(legacyCanonical(sample)));
  });

  // Codex review, 6 November 2026: a JavaScript object puts integer-like keys first in numeric
  // order, so the legacy form wrote {"2":…,"10":…,"a":…}; sorting the names as text broke the
  // stored hash of every experiment protocol with such keys.
  it("keeps integer-like keys first in numeric order, as the legacy form did", () => {
    const keyed = { b: 1, "10": { "2": "x", a: "y" }, a: 2, "2": [{ "1": 0, "01": 1 }] };
    expect(canonicalJson(keyed)).toBe(JSON.stringify(legacyCanonical(keyed)));
    expect(canonicalJson(keyed)).toBe('{"2":[{"1":0,"01":1}],"10":{"2":"x","a":"y"},"a":2,"b":1}');
  });
});
