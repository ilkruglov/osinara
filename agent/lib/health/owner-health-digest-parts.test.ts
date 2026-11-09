/**
 * The owner digest longer than one Telegram message.
 *
 * Constructs covered:
 * - It goes in parts cut at line ends, each within Telegram's 4 096 characters (Codex review,
 *   6 November 2026: with many stuck lanes Telegram refused the whole text, and the claim went back
 *   every ten minutes).
 * - Once a part is in the chat, a failed later part completes the day with its own log code
 *   instead of releasing it (/code-review of 1.8.57–1.8.58: every pass sent the first part again).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOwnerHealthDigestDispatcher,
  formatOwnerHealthDigest,
} from "./owner-health-digest.js";
import {
  ownerHealthDigestDependencies,
  stuckLanesReport,
} from "./owner-health-digest.test-support.js";

afterEach(() => vi.restoreAllMocks());

const AT = new Date("2026-11-06T06:10:00.000Z");

describe("owner digest in parts", () => {
  it("sends a digest longer than one Telegram message in parts cut at line ends", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const huge = stuckLanesReport(40);
    const text = formatOwnerHealthDigest(huge);
    expect(text.length).toBeGreaterThan(4_096);
    const deps = ownerHealthDigestDependencies({ report: vi.fn().mockResolvedValue(huge) });

    await createOwnerHealthDigestDispatcher(deps)(AT);

    const sent = (deps.deliver as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0].chatId === "101")
      .map((call) => String(call[0].text));
    expect(sent.length).toBeGreaterThan(1);
    for (const message of sent) expect(message.length).toBeLessThanOrEqual(4_096);
    expect(sent.join("\n")).toBe(text);
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("counts the day as sent once a part of a long digest is in the chat", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliver = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Telegram 502"));
    const deps = ownerHealthDigestDependencies({
      deliver,
      recipients: vi.fn().mockResolvedValue([{ familyId: "family-1", ownerTelegramUserId: "101" }]),
      report: vi.fn().mockResolvedValue(stuckLanesReport(40)),
    });

    await createOwnerHealthDigestDispatcher(deps)(AT);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_OWNER_HEALTH_DIGEST_PARTIAL"),
    );
  });
});
