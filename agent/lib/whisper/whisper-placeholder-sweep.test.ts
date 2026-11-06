/**
 * The minute sweep of whisper placeholders.
 *
 * Constructs covered:
 * - A placeholder no stored update carries (the queue write rolled back, a redelivery queued
 *   another) is removed.
 * - A placeholder still open after its update ended says that no answer came (a crash between the
 *   end of the update and the failure notice, or a lost fallback).
 * - An edit Telegram did not confirm is tried again with the status and content recorded for it;
 *   the fifth unconfirmed attempt is the last.
 * - Old records are purged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WHISPER_EMPTY_ANSWER_TEXT } from "./telegram-whisper-delivery.js";
import { memoryPlaceholders, PLACEHOLDER_KEY, placeholderApi } from "./whisper-placeholder.test-fixtures.js";
import { sweepWhisperPlaceholders } from "./whisper-placeholder-sweep.js";

const OTHER_KEY = { ...PLACEHOLDER_KEY, placeholderMessageId: 32 };

afterEach(() => vi.restoreAllMocks());

describe("sweepWhisperPlaceholders", () => {
  it("removes an orphan placeholder and closes an unanswered one", async () => {
    const api = placeholderApi();
    const store = memoryPlaceholders({
      stale: [{ ...PLACEHOLDER_KEY, reason: "orphan" }, { ...OTHER_KEY, reason: "unanswered" }],
    });
    store.seed("open");
    store.seed("open", OTHER_KEY);

    await sweepWhisperPlaceholders({ api, placeholders: store.repository });

    expect(api.delete).toHaveBeenCalledExactlyOnceWith(PLACEHOLDER_KEY);
    expect(store.row()).toMatchObject({ pendingContent: null, status: "closed" });
    expect(api.edit).toHaveBeenCalledExactlyOnceWith({ ...OTHER_KEY, content: { format: "plain", text: WHISPER_EMPTY_ANSWER_TEXT } });
    expect(store.row(OTHER_KEY)).toMatchObject({ pendingContent: null, status: "failed" });
    expect(store.repository.purge).toHaveBeenCalledOnce();
  });

  it("tries an unconfirmed edit again with what was recorded for it", async () => {
    const api = placeholderApi();
    api.edit.mockResolvedValueOnce({ body: {}, ok: false, status: 502 });
    const store = memoryPlaceholders();
    store.seed("open");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.repository.transition(PLACEHOLDER_KEY, { content: { format: "plain", text: "Да." }, from: ["open"], to: "answered" });

    await sweepWhisperPlaceholders({ api, placeholders: store.repository });
    expect(store.row()).toMatchObject({ attemptCount: 1, pendingContent: { format: "plain", text: "Да." } });
    await sweepWhisperPlaceholders({ api, placeholders: store.repository });

    expect(api.edit).toHaveBeenCalledTimes(2);
    expect(api.edit).toHaveBeenLastCalledWith({ ...PLACEHOLDER_KEY, content: { format: "plain", text: "Да." } });
    expect(store.row()).toMatchObject({ pendingContent: null, status: "answered" });
  });

  it("gives up after the fifth unconfirmed attempt", async () => {
    const api = placeholderApi();
    api.delete.mockResolvedValue({ body: {}, ok: false, status: 500 });
    const store = memoryPlaceholders();
    store.seed("open");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.repository.transition(PLACEHOLDER_KEY, { content: { remove: true }, from: ["open"], to: "answered" });

    for (let pass = 0; pass < 6; pass += 1) await sweepWhisperPlaceholders({ api, placeholders: store.repository });

    expect(api.delete).toHaveBeenCalledTimes(5);
    expect(store.row()).toMatchObject({ attemptCount: 5, pendingContent: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AGENT_TELEGRAM_WHISPER_DELIVERY_ABANDONED"));
  });
});
