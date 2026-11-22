/**
 * The person card switch.
 *
 * Constructs covered:
 * - Absent or any other value keeps cards on; the usual "off" words switch them off.
 */
import { describe, expect, it } from "vitest";

import { personCardsEnabled } from "./person-card-config.js";

describe("personCardsEnabled", () => {
  it("is off only for an off word", () => {
    for (const value of ["false", "0", "no", "off", " OFF "]) {
      expect(personCardsEnabled({ AGENT_PERSON_CARDS_ENABLED: value })).toBe(false);
    }
    for (const value of [undefined, "", "true", "1", "yes"]) {
      expect(personCardsEnabled({ AGENT_PERSON_CARDS_ENABLED: value })).toBe(true);
    }
  });
});
