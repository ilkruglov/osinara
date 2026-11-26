/**
 * Turn filters for prompt evals.
 *
 * Constructs covered:
 * - A turn counts as addressed when the text of the current message names Mia in any case form or
 *   as "mia", by the same rule that wakes the bot; a word that merely contains the name does not count.
 * - Only the message text is checked, not the sender's name or other envelope fields.
 */
import { describe, expect, it } from "vitest";

import {
  telegramForwardMarker,
  withForwardMarker,
} from "../../agent/lib/telegram-message-policy.js";
import { isAddressedToMia } from "./turn-filters.js";

const envelope = (text: string, sender = "Yuri") =>
  `<current_telegram_message>\n${JSON.stringify({ senderDisplayName: sender, text })}\n</current_telegram_message>`;

describe("isAddressedToMia", () => {
  it("recognises the name in every case form, Cyrillic or Latin", () => {
    for (const text of [
      "Мия, что по шинам?",
      "спроси у Мии",
      "передай Мие",
      "покажи Мию",
      "с Мией не спорь",
      "mia, hi",
      "Мия?",
    ]) {
      expect(isAddressedToMia(envelope(text)), text).toBe(true);
    }
  });

  it("does not count a word that only contains the name, nor a name outside the text", () => {
    expect(isAddressedToMia(envelope("химия и алхимия"))).toBe(false);
    expect(isAddressedToMia(envelope("ну и ладно", "Мия"))).toBe(false);
    expect(isAddressedToMia("без текущего сообщения")).toBe(false);
  });

  // The mark of a forward names its origin, which is no address (review, 26 November 2026).
  it("does not count the origin named in the mark of a forward", () => {
    // The mark as the turn writes it, so a change of its wording cannot pass this test unnoticed.
    const forwarded = (name: string, text: string) =>
      envelope(
        withForwardMarker(
          telegramForwardMarker({
            forward_origin: { sender_user_name: name, type: "hidden_user" },
          }),
          text,
        ),
      );
    expect(isAddressedToMia(forwarded("Мия (osinara_bot)", "привет"))).toBe(false);
    expect(isAddressedToMia(forwarded("Аноним", "Мия, глянь"))).toBe(true);
  });
});
