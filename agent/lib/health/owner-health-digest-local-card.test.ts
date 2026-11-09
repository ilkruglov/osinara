/**
 * The owner digest when its card fails before anything is sent.
 *
 * Construct covered:
 * - A card that cannot be built never reaches the transport, so the text says the card was not
 *   sent, and a text that then fails releases the day for the next pass instead of counting it as
 *   sent (/code-review of 1.8.57–1.8.58: such a failure was taken for a card that may have arrived,
 *   and the day's digest could be lost). A card over the size limit is refused by the transport
 *   before its request (memory-review-owner-alert-transport.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ownerHealthDigestDependencies } from "./owner-health-digest.test-support.js";

vi.mock("./owner-health-digest-widget.js", () => ({
  ownerHealthDigestWidget: () => {
    throw new Error("AGENT_OWNER_DIGEST_WIDGET_BROKEN: карточка не собралась");
  },
}));

const { createOwnerHealthDigestDispatcher } = await import("./owner-health-digest.js");

afterEach(() => vi.restoreAllMocks());

const AT = new Date("2026-11-06T06:10:00.000Z");

type Dependencies = Parameters<typeof createOwnerHealthDigestDispatcher>[0];

function dependencies(
  deliver: Dependencies["deliver"],
  deliverWidget: NonNullable<Dependencies["deliverWidget"]>,
): ReturnType<typeof ownerHealthDigestDependencies> {
  return ownerHealthDigestDependencies({
    deliver,
    deliverWidget,
    recipients: vi.fn().mockResolvedValue([{ familyId: "family-1", ownerTelegramUserId: "101" }]),
  });
}

describe("owner digest with a card that fails before it is sent", () => {
  it("says the card was not sent and does not call Telegram for it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const deliverWidget = vi.fn().mockResolvedValue(undefined);

    await createOwnerHealthDigestDispatcher(dependencies(deliver, deliverWidget))(AT);

    expect(deliverWidget).not.toHaveBeenCalled();
    expect(String(deliver.mock.calls[0]![0].text)).toMatch(/Карточка сводки не отправилась/u);
  });

  it("releases the day when the text after a card that was never sent fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliver = vi.fn().mockRejectedValue(new Error("Telegram 502"));
    const deps = dependencies(deliver, vi.fn().mockResolvedValue(undefined));

    await createOwnerHealthDigestDispatcher(deps)(AT);

    expect(String(deliver.mock.calls[0]![0].text)).toMatch(/Карточка сводки не отправилась/u);
    expect(deps.release).toHaveBeenCalledOnce();
    expect(deps.complete).not.toHaveBeenCalled();
  });
});
