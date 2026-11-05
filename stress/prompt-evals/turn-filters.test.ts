/**
 * Turn filters for prompt evals.
 *
 * Constructs covered:
 * - A turn counts as addressed when the text of the current message names Mia in any case form or
 *   as "mia", by the same rule that wakes the bot; a word that merely contains the name does not count.
 * - Only the message text is checked, not the sender's name or other envelope fields.
 */
import { describe, expect, it } from "vitest";

import { isAddressedToMia } from "./turn-filters.js";

const envelope = (text: string, sender = "Yuri") =>
  `<current_telegram_message>\n${JSON.stringify({ senderDisplayName: sender, text })}\n</current_telegram_message>`;

describe("isAddressedToMia", () => {
  it("recognises the name in every case form, Cyrillic or Latin", () => {
    for (const text of ["Мия, что по шинам?", "спроси у Мии", "передай Мие", "покажи Мию", "с Мией не спорь", "mia, hi", "Мия?"]) {
      expect(isAddressedToMia(envelope(text)), text).toBe(true);
    }
  });

  it("does not count a word that only contains the name, nor a name outside the text", () => {
    expect(isAddressedToMia(envelope("химия и алхимия"))).toBe(false);
    expect(isAddressedToMia(envelope("ну и ладно", "Мия"))).toBe(false);
    expect(isAddressedToMia("без текущего сообщения")).toBe(false);
  });
});
