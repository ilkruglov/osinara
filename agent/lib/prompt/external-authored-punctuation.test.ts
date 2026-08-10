/**
 * External authored-prompt punctuation normalization tests.
 *
 * Construct covered:
 * - `simplifyExternalAuthoredPunctuation`: simple prose and compact ranges without guillemets.
 */
import { describe, expect, it } from "vitest";

import { simplifyExternalAuthoredPunctuation } from "./external-authored-punctuation.js";

describe("simplifyExternalAuthoredPunctuation", () => {
  it("uses plain punctuation without corrupting a compact range", () => {
    expect(simplifyExternalAuthoredPunctuation(
      "Правило — пояснение; «пример»; 10:00–18:00",
    )).toBe("Правило: пояснение; пример; 10:00-18:00");
  });

  it("preserves authored line boundaries around a standalone dash", () => {
    expect(simplifyExternalAuthoredPunctuation("До\n—\nПосле")).toBe("До\n-\nПосле");
  });
});
