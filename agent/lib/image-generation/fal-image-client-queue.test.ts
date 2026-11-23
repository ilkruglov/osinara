/**
 * The fal.ai client's requests to fal's queue, with the queue played by a stub `fetch` or by a raw
 * TCP server behind the real one.
 *
 * Constructs covered:
 * - Each request at its route as SDK 1.10.1 built it (the app is the endpoint's first two
 *   segments), with the key, JSON both ways and `redirect: "error"`; a job named `status-123` is
 *   still asked for its result.
 * - An answer is judged by its status code alone: a reason phrase in Cyrillic does not break it,
 *   a status of 600 is an unknown outcome; a redirect of a poll or a result reaches no other host.
 * - Retries as SDK 1.10.1 made them: a poll up to six requests (429, 500, 502–504, a network
 *   failure, a body that broke off), a result and a cancel up to four (the same but 500), each
 *   pause doubling from the base with ±25 % at random; three 503s and then the picture is still
 *   the picture. Every pause, between polls or before a retry, ends with the job's deadline.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { retryPauseMs } from "./fal-queue-transport.js";
import {
  brokenAnswer,
  dropped,
  falClient as client,
  falQueue,
  IMAGE_REQUEST as request,
  JPEG,
  json,
  rawFalQueue,
  REQUEST_ID,
  UNKNOWN,
} from "./fal-queue.test-fixtures.js";

const APP = "https://queue.fal.run/bytedance/seedream";

/** A step that fails `times` times with `failure`, then answers as fal's happy queue does. */
function failing(times: number, failure: () => Response, then: () => Response): () => Response {
  let calls = 0;
  return () => {
    calls += 1;
    return calls <= times ? failure() : then();
  };
}

describe("fal image client queue", () => {
  beforeEach(() => {
    for (const method of ["error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks the queue at the SDK's routes with the key, JSON both ways and no redirect followed", async () => {
    const drawn = falQueue();
    await client(drawn).generate(request);
    const lost = falQueue({ status: () => json({ detail: "Not found" }, 404) });
    await expect(client(lost).generate(request)).rejects.toMatchObject(UNKNOWN);
    await vi.waitFor(() => expect(lost.cancels()).toHaveLength(1));
    const calls = [...drawn.calls, ...lost.calls];
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://queue.fal.run/bytedance/seedream/v5.5/text-to-image",
      `GET ${APP}/requests/${REQUEST_ID}/status?logs=0`,
      `GET ${APP}/requests/${REQUEST_ID}`,
      "POST https://queue.fal.run/bytedance/seedream/v5.5/text-to-image",
      `GET ${APP}/requests/${REQUEST_ID}/status?logs=0`,
      `PUT ${APP}/requests/${REQUEST_ID}/cancel`,
    ]);
    for (const call of calls) {
      expect(call.redirect).toBe("error");
      expect(Object.fromEntries(call.headers)).toEqual({
        accept: "application/json",
        authorization: "Key key-id:key-secret",
        "content-type": "application/json",
      });
      // Only the submit carries a body: the model's input.
      expect(call.body === undefined).toBe(call.method !== "POST");
    }
  });

  it("asks for the result of a job whose id reads like a route of the queue", async () => {
    const queue = falQueue({ submit: () => json({ request_id: "status-123" }) });
    await expect(client(queue).generate(request)).resolves.toMatchObject({
      mediaType: "image/jpeg",
    });
    expect(queue.calls.map((call) => call.url).slice(1)).toEqual([
      `${APP}/requests/status-123/status?logs=0`,
      `${APP}/requests/status-123`,
    ]);
  });

  it("reads each answer by its status code, whatever its reason phrase", async () => {
    // undici hands a non-ASCII reason phrase on as UTF-8, which `new Response` refused.
    const queue = await rawFalQueue(() => ({ status: "200 Готово" }));
    try {
      await expect(client(queue).generate(request)).resolves.toMatchObject({
        mediaType: "image/jpeg",
      });
      expect(queue.requests).toHaveLength(3);
    } finally {
      queue.close();
    }
  });

  it.each(["submit", "status", "result"] as const)(
    "takes a %s answered with status 600 as an unknown outcome",
    async (step) => {
      const error = vi.mocked(console.error);
      const queue = await rawFalQueue((route) =>
        route === step ? { body: {}, status: "600 Odd" } : undefined,
      );
      try {
        await expect(client(queue).generate(request)).rejects.toMatchObject(UNKNOWN);
        // The status itself is the verdict's reason, not an exception about it.
        expect(error.mock.calls.flat().join("\n")).toMatch(/"detail":"[^"]*\b600\b/u);
        expect(queue.requests.filter((line) => line.startsWith("POST"))).toHaveLength(1);
        if (step !== "submit") {
          await vi.waitFor(() =>
            expect(queue.requests.filter((line) => line.startsWith("PUT"))).toHaveLength(1),
          );
        }
      } finally {
        queue.close();
      }
    },
  );

  it.each(["status", "result"] as const)(
    "follows no redirect of a %s: nothing reaches another host",
    async (step) => {
      const elsewhere = await rawFalQueue(() => undefined);
      const queue = await rawFalQueue((route) =>
        route === step
          ? { headers: { location: `${elsewhere.origin}/stolen` }, status: "307 Moved" }
          : undefined,
      );
      try {
        await expect(client(queue).generate(request)).rejects.toMatchObject(UNKNOWN);
        await vi.waitFor(() =>
          expect(queue.requests.filter((line) => line.startsWith("PUT"))).toHaveLength(1),
        );
        expect(elsewhere.requests).toEqual([]);
      } finally {
        queue.close();
        elsewhere.close();
      }
    },
  );

  it("still brings the picture after three 503s on a poll", async () => {
    const queue = falQueue({
      status: failing(
        3,
        () => json({ detail: "busy" }, 503),
        () => json({ status: "COMPLETED" }),
      ),
    });
    await expect(client(queue).generate(request)).resolves.toMatchObject({
      mediaType: "image/jpeg",
    });
    expect(queue.statusPolls()).toBe(4);
    expect(queue.cancels()).toEqual([]);
  });

  const transient: ReadonlyArray<[string, () => Response]> = [
    ["a rate limit", () => json({ detail: "slow down" }, 429)],
    ["a bad gateway", () => json({ detail: "x" }, 502)],
    ["an unavailable queue", () => json({ detail: "x" }, 503)],
    ["a gateway timeout", () => json({ detail: "x" }, 504)],
    ["a dropped connection", dropped("ECONNRESET")],
    [
      "a fetch failure without a code",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["a body that broke off", brokenAnswer(200)],
  ];

  it.each([...transient, ["an internal error", () => json({ detail: "x" }, 500)] as const])(
    "polls again after %s, six requests at most, then cancels",
    async (_name, failure) => {
      const recovered = falQueue({
        status: failing(5, failure, () => json({ status: "COMPLETED" })),
      });
      await expect(client(recovered).generate(request)).resolves.toMatchObject({
        mediaType: "image/jpeg",
      });
      expect(recovered.statusPolls()).toBe(6);
      const down = falQueue({ status: failure });
      await expect(client(down).generate(request)).rejects.toMatchObject(UNKNOWN);
      expect(down.statusPolls()).toBe(6);
      await vi.waitFor(() => expect(down.cancels()).toHaveLength(1));
    },
  );

  it.each(transient)(
    "asks for a result again after %s, four requests at most",
    async (_name, failure) => {
      const recovered = falQueue({ result: failing(3, failure, () => falQueueResult()) });
      await expect(client(recovered).generate(request)).resolves.toMatchObject({
        mediaType: "image/jpeg",
      });
      expect(recovered.results()).toBe(4);
      const down = falQueue({ result: failure });
      await expect(client(down).generate(request)).rejects.toMatchObject(UNKNOWN);
      expect(down.results()).toBe(4);
    },
  );

  it("asks once for a poll or a result fal refused, and for a result that failed inside", async () => {
    for (const status of [400, 404, 422]) {
      const polled = falQueue({ status: () => json({ detail: "x" }, status) });
      await expect(client(polled).generate(request)).rejects.toMatchObject(UNKNOWN);
      expect(polled.statusPolls()).toBe(1);
    }
    // SDK 1.10.1 retried no 500 of a result: the job itself failed.
    const crashed = falQueue({ result: () => json({ detail: "x" }, 500) });
    await expect(client(crashed).generate(request)).rejects.toMatchObject(UNKNOWN);
    expect(crashed.results()).toBe(1);
  });

  // Final review, 22 November 2026: a 300 or 304 to the submit passes `redirect: "error"` and read
  // as a refusal the model may retry, though fal may hold the job; a poll answered 200 with a body
  // that is not JSON read as «not done yet» and held the call to its deadline.
  it.each(["300 Multiple Choices", "304 Not Modified"])(
    "takes a submit answered %s as an unknown outcome",
    async (status) => {
      const queue = await rawFalQueue((route) =>
        route === "submit" ? { body: {}, status } : undefined,
      );
      try {
        await expect(client(queue).generate(request)).rejects.toMatchObject(UNKNOWN);
      } finally {
        queue.close();
      }
    },
  );

  it("takes a poll it cannot read as an unknown outcome at once, and cancels the job", async () => {
    const broken = falQueue({
      status: () => new Response("{", { headers: { "content-type": "application/json" } }),
    });
    await expect(client(broken).generate(request)).rejects.toMatchObject(UNKNOWN);
    expect(broken.statusPolls()).toBe(1);
    await vi.waitFor(() => expect(broken.cancels()).toHaveLength(1));
  });

  it("retries a cancel fal could not take, four requests at most", async () => {
    const queue = falQueue({
      cancel: () => json({ detail: "x" }, 503),
      status: () => json({ detail: "Not found" }, 404),
    });
    await expect(client(queue).generate(request)).rejects.toMatchObject(UNKNOWN);
    await vi.waitFor(() => expect(queue.cancels()).toHaveLength(4));
    await sleep(50);
    expect(queue.cancels()).toHaveLength(4);
  });

  it("pauses before a retry as SDK 1.10.1 did: doubling from the base, ±25 % at random", () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryPauseMs(attempt, 1_000, () => 0.5))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
    expect(retryPauseMs(1, 1_000, () => 0)).toBe(750);
    expect(retryPauseMs(3, 1_000, () => 0.999_999)).toBeCloseTo(5_000, 1);
  });

  it("ends a pause before a retry or the next poll with the job's deadline", async () => {
    for (const [overrides, status] of [
      [{ retryBaseDelayMs: 60_000 }, () => json({ detail: "x" }, 503)],
      [{ pollIntervalMs: 60_000 }, () => json({ status: "IN_PROGRESS" }, 202)],
    ] as const) {
      const queue = falQueue({ status });
      const started = performance.now();
      await expect(
        client(queue, { ...overrides, timeoutMs: 50 }).generate(request),
      ).rejects.toMatchObject(UNKNOWN);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(queue.statusPolls()).toBe(1);
      await vi.waitFor(() => expect(queue.cancels()).toHaveLength(1));
    }
  });
});

/** The happy result, for a step that recovers. */
function falQueueResult(): Response {
  return json({
    images: [
      { content_type: "image/jpeg", url: `data:image/jpeg;base64,${JPEG.toString("base64")}` },
    ],
  });
}
