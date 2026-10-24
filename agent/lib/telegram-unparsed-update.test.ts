/**
 * Router of verified updates Eve does not parse.
 *
 * Constructs covered:
 * - `createTelegramUnparsedUpdateRouter`: `my_chat_member` goes to the membership handler, a reaction
 *   and any other shape to the reaction recorder; a failed membership write fails the webhook.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramUnparsedUpdateRouter } from "./telegram-unparsed-update.js";

describe("createTelegramUnparsedUpdateRouter", () => {
  it("routes my_chat_member to the membership handler and everything else to the reaction recorder", async () => {
    const membership = vi.fn().mockResolvedValue(new Response("membership"));
    const reaction = vi.fn(async () => new Response("reaction"));
    const route = createTelegramUnparsedUpdateRouter({ membership, reaction });
    const blocked = { my_chat_member: { chat: { id: 101, type: "private" } }, update_id: 1 };
    const reacted = { message_reaction: { chat: { id: -1001 } }, update_id: 2 };

    await expect((await route(blocked)).text()).resolves.toBe("membership");
    await expect((await route(reacted)).text()).resolves.toBe("reaction");
    await expect((await route({ update_id: 3 })).text()).resolves.toBe("reaction");

    expect(membership).toHaveBeenCalledExactlyOnceWith(blocked);
    expect(reaction.mock.calls).toEqual([[reacted], [{ update_id: 3 }]]);
  });

  it("lets a failed membership write fail the webhook, so Telegram delivers the update again", async () => {
    const route = createTelegramUnparsedUpdateRouter({
      membership: vi.fn().mockRejectedValue(new Error("database down")),
      reaction: vi.fn(),
    });
    await expect(route({ my_chat_member: {}, update_id: 4 })).rejects.toThrow("database down");
  });
});
