/**
 * The fal.ai image client, with fal's queue played by a stub `fetch`.
 *
 * Constructs covered:
 * - Generation and editing (Seedream here; each model's endpoints and sizes in
 *   `fal-image-models.test.ts`): the endpoint, the 1.5K sizes, JPEG or PNG for a transparent
 *   background, references as JPEG data URIs, the job reported before its outcome, the picture
 *   typed by its bytes.
 * - The submit itself (one per call, its refusals, the request id): `fal-image-client-submit.test.ts`;
 *   the queue's routes, status codes, redirects and retries: `fal-image-client-queue.test.ts`.
 * - fal's verdicts: a refused key is an outage, a content policy or validation 422 is a rejection
 *   the model may correct once, a job fal ended with an error is an outage, a poll that fails is an
 *   unknown outcome and the job is cancelled; only fal's codes reach the log, never its messages.
 * - An error answer to a poll or a result keeps its status whatever its body, one that broke off
 *   included, and fal's `X-Fal-Error-Type` header names its code when the body names none.
 */
import { setTimeout as sleep } from "node:timers/promises";

import sharp from "sharp";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelFacingError } from "../model-facing-error.js";
import { FAL_IMAGE_MODELS } from "./fal-image-models.js";
import {
  brokenAnswer,
  falClient as client,
  falQueue,
  IMAGE_REQUEST as request,
  JPEG,
  json,
  OUTAGE,
  REQUEST_ID,
  UNKNOWN,
} from "./fal-queue.test-fixtures.js";

const SEEDREAM = FAL_IMAGE_MODELS["seedream-5.5"];

describe("fal image client", () => {
  beforeEach(() => {
    for (const method of ["error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("generates at the 1.5K tier, reports the job first and types the picture by its bytes", async () => {
    const log = vi.mocked(console.log);
    const queue = falQueue();
    let pollsBeforeLedger: number | undefined;
    const onProviderJob = vi.fn(async () => {
      pollsBeforeLedger = queue.statusPolls();
    });
    const image = await client(queue).generate({ ...request, onProviderJob });
    // The job is in the ledger before its status is first asked for.
    expect(pollsBeforeLedger).toBe(0);
    expect(image).toMatchObject({
      mediaType: "image/jpeg",
      model: `fal/${SEEDREAM.textToImage}`,
    });
    const [submit] = queue.posts();
    expect(submit!.url).toBe(`https://queue.fal.run/${SEEDREAM.textToImage}`);
    expect(submit!.headers.get("authorization")).toBe("Key key-id:key-secret");
    expect(submit!.body).toEqual({
      background: "auto",
      image_size: { height: 1_536, width: 1_536 },
      num_images: 1,
      output_format: "jpeg",
      prompt: request.prompt,
      // The picture comes back inside the result: no CDN, no copy in fal's request history.
      sync_mode: true,
    });
    expect(onProviderJob).toHaveBeenCalledWith({
      jobId: REQUEST_ID,
      model: SEEDREAM.textToImage,
      provider: "fal",
    });
    expect(log.mock.calls.flat().join("\n")).toContain('"estimatedUsd":0.03');
  });

  it("lets the model pick proportions for auto and draws a transparent background as PNG", async () => {
    const queue = falQueue();
    await client(queue).generate({ ...request, background: "transparent", size: "auto" });
    await client(queue).generate({ ...request, size: "1024x1536" });
    const [auto, portrait] = queue.posts();
    expect(auto!.body).toMatchObject({
      background: "transparent",
      image_size: "auto_1.5K",
      output_format: "png",
    });
    expect(portrait!.body).toMatchObject({ image_size: { height: 1_944, width: 1_296 } });
  });

  it("edits with every reference as a JPEG data URI, and refuses a fifth before POST", async () => {
    const log = vi.mocked(console.log);
    const png = await sharp({
      create: { background: "red", channels: 3, height: 600, width: 2_400 },
    })
      .png()
      .toBuffer();
    const tall = await sharp({
      create: { background: "blue", channels: 3, height: 300, width: 100 },
    })
      .png()
      .toBuffer();
    const queue = falQueue();
    await client(queue).generate({
      ...request,
      referenceImages: [
        { bytes: png, mediaType: "image/png" },
        { bytes: tall, mediaType: "image/png" },
      ],
    });
    // Each reference adds $0.012 to the $0.03 picture.
    expect(log.mock.calls.flat().join("\n")).toContain('"estimatedUsd":0.054');
    const [edit] = queue.posts();
    expect(edit!.url).toBe(`https://queue.fal.run/${SEEDREAM.edit}`);
    const urls = (edit!.body as { image_urls: string[] }).image_urls;
    expect(urls).toHaveLength(2);
    const decoded = urls.map((url) =>
      Buffer.from(url.replace(/^data:image\/jpeg;base64,/u, ""), "base64"),
    );
    expect(await sharp(decoded[0]!).metadata()).toMatchObject({
      format: "jpeg",
      height: 384,
      width: 1_536,
    });
    // The prompt names the first and the second picture: the order is kept.
    expect(await sharp(decoded[1]!).metadata()).toMatchObject({ height: 300, width: 100 });

    const five = falQueue();
    await expect(
      client(five).generate({
        ...request,
        referenceImages: Array.from({ length: 5 }, () => ({ bytes: png, mediaType: "image/png" })),
      }),
    ).rejects.toMatchObject({ code: "AGENT_IMAGE_EDITING_INPUT_INVALID" });
    expect(five.calls).toEqual([]);

    // A source the reader took (its signature is JPEG) that does not decode is named by its place
    // (repeat review, 23 November 2026: the advice said «images» with two sources).
    const cut = falQueue();
    await expect(
      client(cut).generate({
        ...request,
        referenceImages: [
          { bytes: png, mediaType: "image/png" },
          { bytes: Buffer.from([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "AGENT_IMAGE_EDITING_INPUT_INVALID",
      contract: { field: "images[1]", reason: expect.stringMatching(/^Исходник 2: /u) },
    });
    expect(cut.calls).toEqual([]);
  });

  it("takes a refused key as an outage and an invalid request as a rejection", async () => {
    const refused = falQueue({ submit: () => json({ detail: "No user found" }, 401) });
    await expect(client(refused).generate(request)).rejects.toMatchObject(OUTAGE);
    const invalid = falQueue({
      submit: () => json({ detail: [{ loc: ["body", "prompt"], msg: "x", type: "missing" }] }, 422),
    });
    await expect(client(invalid).generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
    });
  });

  it("rejects a job fal's filter stopped, logging its code and not its message", async () => {
    const error = vi.mocked(console.error);
    const queue = falQueue({
      result: () =>
        json(
          {
            detail: [
              {
                input: { prompt: "СЕКРЕТНЫЙ_ПРОМПТ" },
                loc: ["body", "prompt"],
                msg: "СЕКРЕТНЫЙ_ПРОМПТ flagged",
                type: "content_policy_violation",
              },
            ],
          },
          422,
        ),
    });
    await expect(client(queue).generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
    });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("content_policy_violation");
    expect(logged).not.toContain("СЕКРЕТНЫЙ_ПРОМПТ");
  });

  it("takes a failed job as an outage and an unanswered poll or a missing picture as unknown", async () => {
    const failed = falQueue({
      result: () =>
        json({ detail: [{ loc: ["body"], msg: "x", type: "internal_server_error" }] }, 500),
    });
    await expect(client(failed).generate(request)).rejects.toMatchObject(OUTAGE);
    const stuck = falQueue({ status: () => json({ status: "IN_PROGRESS" }, 202) });
    await expect(client(stuck, { timeoutMs: 30 }).generate(request)).rejects.toMatchObject(UNKNOWN);
    // The client asks fal to cancel the job it stopped waiting for.
    expect(stuck.cancels()).toHaveLength(1);
    // A link instead of the inline picture is fetched from nowhere: fal ignored sync_mode.
    const linked = falQueue({
      result: () => json({ images: [{ url: "https://v3b.fal.media/files/result.jpg" }] }),
    });
    await expect(client(linked).generate(request)).rejects.toMatchObject(UNKNOWN);
    expect(linked.calls.every((call) => call.url.startsWith("https://queue.fal.run/"))).toBe(true);
  });

  it("refuses a result answer past its bound before it fills memory, and a broken picture", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("A".repeat(1024 * 1024));
    const endless = falQueue({
      result: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(chunk);
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await expect(client(endless).generate(request)).rejects.toMatchObject(UNKNOWN);
    expect(pulled).toBeLessThan(80);
    // The signature of a JPEG over a cut-off picture is not a picture.
    const cut = JPEG.subarray(0, JPEG.length - 40);
    const broken = falQueue({
      result: () => json({ images: [{ url: `data:image/jpeg;base64,${cut.toString("base64")}` }] }),
    });
    await expect(client(broken).generate(request)).rejects.toMatchObject(UNKNOWN);
  });

  it("bounds the whole job by one deadline and stops polling with it", async () => {
    for (const step of ["submit", "result"] as const) {
      const hung = falQueue({ [step]: () => "hang" as const });
      await expect(client(hung, { timeoutMs: 50 }).generate(request)).rejects.toMatchObject(
        UNKNOWN,
      );
    }
    // A status answer still on its way when the deadline passes must not schedule another poll.
    const slow = falQueue({
      status: async (signal) => {
        await sleep(40, undefined, { signal });
        return json({ status: "IN_PROGRESS" }, 202);
      },
    });
    await expect(client(slow, { timeoutMs: 30 }).generate(request)).rejects.toMatchObject(UNKNOWN);
    const polled = slow.statusPolls();
    await sleep(150);
    expect(slow.statusPolls()).toBe(polled);
    // The deadline cut a status request short, and fal is still asked to drop the job.
    expect(slow.cancels()).toHaveLength(1);
  });

  it("cancels an accepted job it gave up on, with the cancel bounded on its own", async () => {
    // fal refuses to cancel a job it no longer has; that refusal goes nowhere.
    const lost = falQueue({
      cancel: () => json({ detail: "Request not found" }, 404),
      status: () => json({ detail: "Not found" }, 404),
    });
    await expect(client(lost).generate(request)).rejects.toMatchObject(UNKNOWN);
    // Not the job's signal, which is aborted once the call ends.
    expect(lost.cancels()[0]?.signal?.aborted).toBe(false);
    // A cancel fal never answers is cut off by its own bound.
    const unanswered = falQueue({
      cancel: () => "hang",
      status: () => json({ detail: "Not found" }, 404),
    });
    await expect(
      client(unanswered, { cancelTimeoutMs: 30 }).generate(request),
    ).rejects.toMatchObject(UNKNOWN);
    const [hung] = unanswered.cancels();
    expect(hung?.signal?.aborted).toBe(false);
    await sleep(80);
    expect(hung?.signal?.aborted).toBe(true);
    // A ledger that fails after fal accepted the job leaves it to nobody but the cancel.
    const unrecorded = falQueue();
    await expect(
      client(unrecorded).generate({
        ...request,
        onProviderJob: async () => {
          throw new Error("ledger down");
        },
      }),
    ).rejects.toMatchObject(UNKNOWN);
    expect(unrecorded.cancels()).toHaveLength(1);
  });

  it("takes any job fal ended with an error as an outage, not a rejection", async () => {
    for (const errorType of [
      "runner_scheduling_failure",
      "client_disconnected",
      "bad_request",
      "a_code_fal_adds_later",
    ]) {
      const ended = falQueue({
        status: () => json({ error: "x", error_type: errorType, status: "COMPLETED" }),
      });
      await expect(client(ended).generate(request)).rejects.toMatchObject(OUTAGE);
    }
    // A refusal by the model, should fal report it in the status, keeps its advice.
    const filtered = falQueue({
      status: () =>
        json({ error: "x", error_type: "content_policy_violation", status: "COMPLETED" }),
    });
    await expect(client(filtered).generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
    });
    const crashed = falQueue({
      result: () => json({ detail: "Runner failed", error_type: "runner_server_error" }, 500),
    });
    await expect(client(crashed).generate(request)).rejects.toMatchObject(OUTAGE);
  });

  describe("an error answer to a poll or a result", () => {
    /** An answer with `status` whose body is `body` as is, JSON by its header unless overridden. */
    const raw =
      (status: number, body: string, headers: Record<string, string> = {}) =>
      () =>
        new Response(body, { headers: { "content-type": "application/json", ...headers }, status });
    // fal names an error's type in this header as well as in `error_type` (fal.ai/docs, errors).
    const failed = { "x-fal-error-type": "runner_server_error" };

    it.each([
      ["a refusal with a broken body", raw(422, "{"), { code: "AGENT_IMAGE_GENERATION_REJECTED" }],
      ["a failed job with a broken body", raw(500, '{"detail":"Runner fa', failed), OUTAGE],
      ["a failed job named by its header only", () => json({ detail: "x" }, 500, failed), OUTAGE],
      [
        "a failed job with a text body",
        raw(500, "Internal Server Error", { ...failed, "content-type": "text/plain" }),
        OUTAGE,
      ],
      // The status came, then the connection dropped: the status still decides.
      [
        "a refusal whose body broke off",
        brokenAnswer(422),
        { code: "AGENT_IMAGE_GENERATION_REJECTED" },
      ],
      [
        "a filtered refusal whose body broke off",
        brokenAnswer(422, { "x-fal-error-type": "content_policy_violation" }),
        { contract: { correction: expect.stringContaining("брендов") } },
      ],
      ["a failed job whose body broke off", brokenAnswer(500, failed), OUTAGE],
    ])("keeps fal's status and its error header for %s", async (_name, result, outcome) => {
      await expect(client(falQueue({ result })).generate(request)).rejects.toMatchObject(outcome);
    });

    it("keeps the codes of the body over the header's, and a poll's status in the log", async () => {
      const error = vi.mocked(console.error);
      const tooSmall = { loc: ["body", "image_urls", 0], msg: "x", type: "image_too_small" };
      const filtered = { "x-fal-error-type": "content_policy_violation" };
      const source = falQueue({ result: () => json({ detail: [tooSmall] }, 422, filtered) });
      await expect(client(source).generate(request)).rejects.toMatchObject({
        contract: { field: "images" },
      });
      const lost = falQueue({ status: raw(404, "{") });
      await expect(client(lost).generate(request)).rejects.toMatchObject(UNKNOWN);
      expect(error.mock.calls.flat().join("\n")).toContain('"detail":"status 404"');
    });
  });

  it("lets the model correct a refusal once, telling it what to change by fal's reason", async () => {
    const refusal = async (type: string) => {
      const queue = falQueue({
        result: () => json({ detail: [{ loc: ["body"], msg: "x", type }] }, 422),
      });
      const failure: unknown = await client(queue)
        .generate(request)
        .catch((error: unknown) => error);
      assert(failure instanceof ModelFacingError);
      const { contract } = failure;
      // Nothing was made: not a maybe-billed outcome, and one corrected call is allowed.
      expect(contract).toMatchObject({
        category: "input",
        code: "AGENT_IMAGE_GENERATION_REJECTED",
        retryable: true,
        sideEffectStatus: "not_started",
      });
      return contract;
    };
    const content = await refusal("content_policy_violation");
    expect(content.correction).toContain("брендов");
    // The filter may have stopped the photo rather than the words.
    expect(content.correction).toContain("исходник");
    for (const type of ["image_too_small", "image_too_large", "face_detection_error"]) {
      const source = await refusal(type);
      expect(source).toMatchObject({ field: "images" });
      expect(source.correction).not.toContain("брендов");
      expect(source.correction).not.toContain("покрупнее");
    }
    expect((await refusal("no_media_generated")).correction).not.toContain("брендов");
  });
});
