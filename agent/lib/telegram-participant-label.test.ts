/**
 * Participant label tests.
 *
 * Tests:
 * - Display name and username together read «Имя (username)», the form the memory review uses.
 * - Either part alone is the label; a label already ending in «(username)» is not doubled, a name
 *   that merely contains the username still gets it.
 */
import { describe, expect, it } from "vitest";

import { participantLabel } from "./telegram-participant-label.js";

describe("participantLabel", () => {
  it("puts the username next to the display name", () => {
    expect(participantLabel("Ilya", "Ilya_Demchenko")).toBe("Ilya (Ilya_Demchenko)");
    expect(participantLabel("Ilya Kruglov", "@ilya_kruglov")).toBe("Ilya Kruglov (ilya_kruglov)");
  });

  it("falls back to whichever part is present", () => {
    expect(participantLabel("Анна", null)).toBe("Анна");
    expect(participantLabel(null, "anna")).toBe("anna");
    expect(participantLabel("  ", " ")).toBeNull();
    expect(participantLabel("anna_k", "Anna_K")).toBe("anna_k");
  });

  it("skips the username only when the label already ends with it", () => {
    expect(participantLabel("Анна (anna)", "anna")).toBe("Анна (anna)");
    // A name that merely contains the username still needs it spelled out (Codex review).
    expect(participantLabel("Alice Smith", "alice")).toBe("Alice Smith (alice)");
  });
});
