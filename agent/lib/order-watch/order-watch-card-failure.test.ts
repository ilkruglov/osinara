/**
 * The diagnostic code of a failed order card send.
 *
 * Construct covered:
 * - Telegram's refusal is `AGENT_ORDER_WATCH_CARD_REFUSED`; a server error or a success without the
 *   message is `AGENT_ORDER_WATCH_CARD_AMBIGUOUS`, since the card may be in the chat (Codex review,
 *   6 November 2026).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../database.js", () => ({ database: vi.fn() }));

const { orderCardSendFailure } = await import("./order-watch-production.js");

describe("orderCardSendFailure", () => {
  it("names a refusal and an unknown outcome apart", () => {
    expect(orderCardSendFailure({ ambiguous: false, status: 400 })).toMatchObject({ code: "AGENT_ORDER_WATCH_CARD_REFUSED" });
    expect(orderCardSendFailure({ ambiguous: true, status: 502 })).toMatchObject({ code: "AGENT_ORDER_WATCH_CARD_AMBIGUOUS" });
  });
});
