/**
 * The person card model call.
 *
 * Constructs covered:
 * - A streamed answer is read whole, with its usage.
 * - Only a stream that finished with `stop` is an answer: length and the filter are definite,
 *   anything else is unclear; a stream error surfaces as thrown and is not logged by the SDK.
 * - Failures are described by the transport's code on the cause chain, unclear only when the same
 *   request may still succeed (the SDK's "do not retry" kept); a stream error after the answer
 *   began, DeepSeek's reasoning included (checked through the real transport), is no refusal
 *   before work.
 */
import { APICallError } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { createConfiguredLanguageModel } from "../model-transport.js";
import {
  describeModelFailure,
  generatePersonCard,
  PersonCardAnswerInterrupted,
} from "./person-card-generation.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 100, total: 100 },
  outputTokens: { reasoning: 40, text: 10, total: 50 },
};

function streaming(parts: unknown[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: parts as never[] }),
    }),
  });
}

describe("generatePersonCard", () => {
  it("reads the whole streamed answer with its usage", async () => {
    const model = streaming([
      { type: "stream-start", warnings: [] },
      { id: "t", type: "text-start" },
      { delta: '{"facts":', id: "t", type: "text-delta" },
      { delta: "[]}", id: "t", type: "text-delta" },
      { id: "t", type: "text-end" },
      { finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage },
    ]);
    expect(await generatePersonCard({ prompt: "p", system: "s" }, model)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 40,
      text: '{"facts":[]}',
    });
  });

  it("fails on an answer cut by length and surfaces a stream error", async () => {
    const cut = streaming([
      { type: "stream-start", warnings: [] },
      { id: "t", type: "text-start" },
      { delta: "{", id: "t", type: "text-delta" },
      { finishReason: { raw: "length", unified: "length" }, type: "finish", usage },
    ]);
    await expect(generatePersonCard({ prompt: "p", system: "s" }, cut)).rejects.toMatchObject({
      code: "AGENT_MODEL_OUTPUT_TRUNCATED",
    });
    const broken = streaming([
      { type: "stream-start", warnings: [] },
      { error: new AppError("AGENT_MODEL_PROVIDER_ERROR", "500"), type: "error" },
    ]);
    await expect(generatePersonCard({ prompt: "p", system: "s" }, broken)).rejects.toMatchObject({
      code: "AGENT_MODEL_PROVIDER_ERROR",
    });
  });
});

describe("generatePersonCard endings", () => {
  it("treats a filtered answer as definite and an unfinished one as incomplete, logging nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ending = (unified: string) =>
      streaming([
        { type: "stream-start", warnings: [] },
        { id: "t", type: "text-start" },
        { delta: '{"facts":[]}', id: "t", type: "text-delta" },
        { finishReason: { raw: unified, unified }, type: "finish", usage },
      ]);
    await expect(
      generatePersonCard({ prompt: "p", system: "s" }, ending("content-filter")),
    ).rejects.toMatchObject({
      code: "AGENT_MODEL_OUTPUT_FILTERED",
    });
    await expect(
      generatePersonCard({ prompt: "p", system: "s" }, ending("other")),
    ).rejects.toMatchObject({
      code: "AGENT_MODEL_OUTPUT_INCOMPLETE",
    });
    const broken = streaming([
      { type: "stream-start", warnings: [] },
      { error: { message: "CARD_PRIVATE_SENTINEL", isRetryable: true }, type: "error" },
    ]);
    await expect(
      generatePersonCard({ prompt: "CARD_PRIVATE_SENTINEL", system: "s" }, broken),
    ).rejects.toBeDefined();
    expect(JSON.stringify(error.mock.calls)).not.toContain("CARD_PRIVATE_SENTINEL");
    error.mockRestore();
  });
});

describe("describeModelFailure", () => {
  const status = (statusCode: number, isRetryable = true) =>
    new APICallError({
      isRetryable,
      message: "status",
      requestBodyValues: {},
      statusCode,
      url: "https://api.deepseek.com/responses",
    });
  const failure = (code: string, unclear: boolean, refusedBeforeWork = false) => ({
    code,
    refusedBeforeWork,
    unclear,
  });

  it("takes the transport's code from the cause chain and retries only what may succeed", () => {
    const wrapped = new APICallError({
      cause: new AppError("AGENT_MODEL_RESPONSE_TIMEOUT", "silence"),
      message: "timeout",
      requestBodyValues: {},
      url: "https://api.deepseek.com/responses",
    });
    expect(describeModelFailure(wrapped, "F")).toEqual(
      failure("AGENT_MODEL_RESPONSE_TIMEOUT", true),
    );
    expect(describeModelFailure(new AppError("AGENT_MODEL_BALANCE_EXHAUSTED", "402"), "F")).toEqual(
      failure("AGENT_MODEL_BALANCE_EXHAUSTED", false, true),
    );
    expect(describeModelFailure(new TypeError("fetch failed"), "F")).toEqual(failure("F", true));
    expect(describeModelFailure(new Error("boom"), "F")).toEqual(failure("F", false));
    // A body cut mid-stream: the SDK wraps the TypeError as a non-retryable error of a 200.
    const cut = new APICallError({
      cause: new TypeError("terminated"),
      isRetryable: false,
      message: "Failed to process successful response",
      requestBodyValues: {},
      statusCode: 200,
      url: "https://api.deepseek.com/responses",
    });
    expect(describeModelFailure(cut, "F")).toEqual(failure("F", true));
    // A provider error event in the stream is a plain object.
    expect(describeModelFailure({ isRetryable: true, message: "server_error" }, "F")).toEqual(
      failure("F", true),
    );
    expect(describeModelFailure(new AppError("AGENT_MODEL_OUTPUT_INCOMPLETE", "eof"), "F")).toEqual(
      failure("AGENT_MODEL_OUTPUT_INCOMPLETE", true),
    );
    expect(
      describeModelFailure(new AppError("AGENT_MODEL_OUTPUT_FILTERED", "filter"), "F"),
    ).toEqual(failure("AGENT_MODEL_OUTPUT_FILTERED", false));
  });

  it("names a status the transport passed on, so a refusal before work is told apart", () => {
    expect(describeModelFailure(status(429), "F")).toEqual(
      failure("AGENT_MODEL_RATE_LIMITED", true, true),
    );
    expect(describeModelFailure(status(503), "F")).toEqual(
      failure("AGENT_MODEL_PROVIDER_OVERLOADED", true, true),
    );
    expect(describeModelFailure(status(500), "F")).toEqual(
      failure("AGENT_MODEL_PROVIDER_ERROR", true),
    );
    // `insufficient_quota` arrives as a 429 the SDK will not retry.
    expect(describeModelFailure(status(429, false), "F")).toEqual(
      failure("AGENT_MODEL_RATE_LIMITED", false, true),
    );
  });

  it("tells a stream error after the answer began from a refusal before it", async () => {
    const plain429 = (isRetryable: boolean) => ({
      code: "insufficient_quota",
      isRetryable,
      message: "q",
      statusCode: 429,
      type: "error",
    });
    const failed = async (parts: unknown[]) =>
      generatePersonCard({ prompt: "p", system: "s" }, streaming(parts)).then(
        () => null,
        (error: unknown) => error,
      );
    for (const started of [
      [
        { id: "t", type: "text-start" },
        { delta: "{", id: "t", type: "text-delta" },
      ],
      [
        { id: "r", type: "reasoning-start" },
        { delta: "думаю", id: "r", type: "reasoning-delta" },
      ],
      // A reasoning item opened: DeepSeek's reasoning tokens themselves become no part.
      [{ id: "r", type: "reasoning-start" }],
    ]) {
      const error = await failed([
        { type: "stream-start", warnings: [] },
        ...started,
        { error: plain429(true), type: "error" },
      ]);
      expect(error).toBeInstanceOf(PersonCardAnswerInterrupted);
      // The provider's code stays for the logs; the call did work.
      expect(describeModelFailure(error, "F")).toEqual(failure("AGENT_MODEL_RATE_LIMITED", true));
    }
    const refused = await failed([
      { type: "stream-start", warnings: [] },
      { error: plain429(false), type: "error" },
    ]);
    expect(describeModelFailure(refused, "F")).toEqual(
      failure("AGENT_MODEL_RATE_LIMITED", false, true),
    );
  });
});

describe("generatePersonCard through the DeepSeek transport", () => {
  const sse = (events: Array<Record<string, unknown>>) =>
    new Response(
      events
        .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    );
  const created = {
    response: { created_at: 1, id: "r", model: "m" },
    sequence_number: 0,
    type: "response.created",
  };
  const model = (events: Array<Record<string, unknown>>) =>
    createConfiguredLanguageModel({
      apiKey: "test",
      fetch: async () => sse(events),
      maxOutputTokens: 100,
      modelId: "deepseek-flash",
      transport: {
        baseUrl: "https://api.deepseek.com",
        protocol: "deepseek-responses",
        reasoning: { effort: "high" },
      },
    });
  const failure = (events: Array<Record<string, unknown>>) =>
    generatePersonCard({ prompt: "p", system: "s" }, model(events)).then(
      () => null,
      (error: unknown) => describeModelFailure(error, "F"),
    );

  it("takes DeepSeek's reasoning as the answer begun, and a refusal before it as free", async () => {
    expect(
      await failure([
        created,
        {
          item: { id: "rs", summary: [], type: "reasoning" },
          output_index: 0,
          sequence_number: 1,
          type: "response.output_item.added",
        },
        {
          content_index: 0,
          delta: "думаю",
          item_id: "rs",
          output_index: 0,
          sequence_number: 2,
          type: "response.reasoning_text.delta",
        },
        {
          response: { error: { code: "rate_limit_exceeded", message: "x" } },
          sequence_number: 3,
          type: "response.failed",
        },
      ]),
    ).toEqual({ code: "AGENT_MODEL_RATE_LIMITED", refusedBeforeWork: false, unclear: true });
    expect(
      await failure([
        created,
        { code: "insufficient_quota", message: "q", sequence_number: 1, type: "error" },
      ]),
    ).toEqual({ code: "AGENT_MODEL_RATE_LIMITED", refusedBeforeWork: true, unclear: false });
  });
});
