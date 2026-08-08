/**
 * Telegram final-delivery failure-message suppression tests.
 *
 * Constructs covered:
 * - A definitive failed send permits the ordinary turn failure message.
 * - Started, delivered, and ambiguous sends suppress a potentially duplicate failure message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("./database.js", () => ({
  database: () => ({ query }),
}));

import { telegramFinalDeliveryRepository } from "./telegram-final-delivery-repository.js";

describe("Telegram final-delivery failure suppression", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["pending", false],
    ["failed", false],
    ["started", true],
    ["delivered", true],
    ["ambiguous", true],
  ] as const)("maps %s delivery to suppression=%s", async (status, expected) => {
    query.mockResolvedValue({ rows: [{ status }] });

    await expect(
      telegramFinalDeliveryRepository.shouldSuppressFailureMessage("turn-1"),
    ).resolves.toBe(expected);
  });

  it("does not suppress failure when no final-delivery intent exists", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(
      telegramFinalDeliveryRepository.shouldSuppressFailureMessage("turn-missing"),
    ).resolves.toBe(false);
  });
});
