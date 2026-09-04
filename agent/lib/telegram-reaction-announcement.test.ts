/**
 * Reaction set announcement tests.
 *
 * Constructs covered:
 * - The announcement names the exact set and carries the block the standing rules point at.
 * - Presence is detected in plain and part-shaped history messages.
 * - A changed set renders a different announcement, so absence covers both change and compaction.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  announcesReactionSet,
  formatReactionSetAnnouncement,
  REACTION_SET_OPEN_TAG,
} from "./telegram-reaction-announcement.js";

const announcement = formatReactionSetAnnouncement(["👍", "❤️", "🔥"]);

describe("reaction set announcement", () => {
  it("names the set inside the block the rules reference", () => {
    expect(announcement).toContain(REACTION_SET_OPEN_TAG);
    expect(announcement).toContain("👍 ❤️ 🔥");
  });

  it("finds the announcement in a plain history message", () => {
    const messages: ModelMessage[] = [{ content: announcement, role: "user" }];

    expect(announcesReactionSet(messages, announcement)).toBe(true);
  });

  it("finds the announcement inside message parts", () => {
    const messages: ModelMessage[] = [
      { content: [{ text: announcement, type: "text" }], role: "user" },
    ];

    expect(announcesReactionSet(messages, announcement)).toBe(true);
  });

  it("reports absence when history carries a different set", () => {
    const messages: ModelMessage[] = [
      { content: formatReactionSetAnnouncement(["👍", "❤️"]), role: "user" },
    ];

    expect(announcesReactionSet(messages, announcement)).toBe(false);
  });

  it("reports absence for empty history", () => {
    expect(announcesReactionSet([], announcement)).toBe(false);
  });
});
