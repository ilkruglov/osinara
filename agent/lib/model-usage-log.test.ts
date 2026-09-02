/**
 * Model usage observability tests.
 *
 * Constructs covered:
 * - Provider usage payloads normalize to one cache-aware shape across wire protocols.
 * - Streaming and JSON model responses emit exactly one structured usage log each.
 * - Eve `step.completed` events project session identity next to framework usage.
 */
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredLanguageModel } from "./model-transport.js";
import {
  formatStepUsageLog,
  normalizeProviderUsage,
  observeModelUsage,
} from "./model-usage-log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function sseResponse(lines: readonly string[]): Response {
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

describe("normalizeProviderUsage", () => {
  it("maps DeepSeek chat-completions usage including cache hit and reasoning details", () => {
    expect(normalizeProviderUsage({
      completion_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 25 },
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
      prompt_tokens: 1_000,
      total_tokens: 1_040,
    })).toEqual({
      cacheHitTokens: 900,
      cacheMissTokens: 100,
      completionTokens: 40,
      promptTokens: 1_000,
      reasoningTokens: 25,
    });
  });

  it("maps OpenAI-style cached_tokens when provider-specific cache fields are absent", () => {
    expect(normalizeProviderUsage({
      completion_tokens: 10,
      prompt_tokens: 500,
      prompt_tokens_details: { cached_tokens: 200 },
    })).toEqual({
      cacheHitTokens: 200,
      cacheMissTokens: 300,
      completionTokens: 10,
      promptTokens: 500,
      reasoningTokens: null,
    });
  });

  it("maps Anthropic Messages usage", () => {
    expect(normalizeProviderUsage({
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 700,
      input_tokens: 30,
      output_tokens: 12,
    })).toEqual({
      cacheHitTokens: 700,
      cacheMissTokens: 80,
      completionTokens: 12,
      promptTokens: 780,
      reasoningTokens: null,
    });
  });

  it("returns null for payloads without token counts", () => {
    expect(normalizeProviderUsage({ foo: 1 })).toBeNull();
    expect(normalizeProviderUsage(null)).toBeNull();
  });
});

describe("observeModelUsage", () => {
  it("logs once for a streaming response and passes the body through unchanged", async () => {
    const log = vi.fn();
    const lines = [
      'data: {"choices":[{"delta":{"content":"При"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"вет"}}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":64,"prompt_cache_miss_tokens":36,"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}',
      "",
      "data: [DONE]",
      "",
    ];
    const observed = observeModelUsage(sseResponse(lines), { modelId: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions" }, log);

    expect(await observed.text()).toBe(lines.join("\n"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      cacheHitTokens: 64,
      cacheMissTokens: 36,
      code: "AGENT_MODEL_USAGE",
      completionTokens: 2,
      modelId: "deepseek-v4-flash",
      promptTokens: 100,
      reasoningTokens: 1,
      url: "https://api.deepseek.com/chat/completions",
    });
  });

  it("logs once for a JSON response", async () => {
    const log = vi.fn();
    const body = JSON.stringify({ choices: [], usage: { completion_tokens: 3, prompt_tokens: 20 } });
    const observed = observeModelUsage(new Response(body, {
      headers: { "content-type": "application/json" },
      status: 200,
    }), { modelId: "m", url: "https://example.test/v1" }, log);

    expect(await observed.text()).toBe(body);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      code: "AGENT_MODEL_USAGE",
      completionTokens: 3,
      promptTokens: 20,
    });
  });

  it("does not log when the stream carries no usage", async () => {
    const log = vi.fn();
    const observed = observeModelUsage(
      sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}', "", "data: [DONE]", ""]),
      { modelId: "m", url: "https://example.test/v1" },
      log,
    );

    await observed.text();
    expect(log).not.toHaveBeenCalled();
  });

  it("leaves error responses untouched", async () => {
    const log = vi.fn();
    const observed = observeModelUsage(
      new Response('{"error":{"message":"bad"}}', { status: 500 }),
      { modelId: "m", url: "https://example.test/v1" },
      log,
    );

    expect(observed.status).toBe(500);
    await observed.text();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("configured model transport usage logging", () => {
  it("emits one usage log for a DeepSeek chat-completions call", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        index: 0,
        message: { content: "Готово", role: "assistant" },
      }],
      created: 1,
      id: "chatcmpl_1",
      model: "deepseek-v4-flash",
      object: "chat.completion",
      usage: {
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 2 },
        prompt_cache_hit_tokens: 30,
        prompt_cache_miss_tokens: 12,
        prompt_tokens: 42,
      },
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch,
      maxOutputTokens: 128_000,
      modelId: "deepseek-v4-flash",
      transport: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-completions",
        providerName: "deepseek",
        reasoning: { effort: "low", format: "deepseek", type: "effort" },
      },
    });

    await expect(generateText({ model, prompt: "Проверка" })).resolves.toMatchObject({ text: "Готово" });
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({
      cacheHitTokens: 30,
      cacheMissTokens: 12,
      code: "AGENT_MODEL_USAGE",
      completionTokens: 5,
      modelId: "deepseek-v4-flash",
      promptTokens: 42,
      reasoningTokens: 2,
      url: "https://api.deepseek.com/chat/completions",
    });
  });
});

describe("formatStepUsageLog", () => {
  it("projects session identity and framework usage from a step.completed event", () => {
    expect(JSON.parse(formatStepUsageLog({
      data: {
        finishReason: "tool-calls",
        sequence: 7,
        stepIndex: 3,
        turnId: "turn_1",
        usage: { cacheReadTokens: 10, inputTokens: 120, outputTokens: 8 },
      },
      type: "step.completed",
    }, { channelKind: "telegram", sessionId: "session_1" }))).toEqual({
      cacheReadTokens: 10,
      channelKind: "telegram",
      code: "AGENT_MODEL_STEP",
      finishReason: "tool-calls",
      inputTokens: 120,
      outputTokens: 8,
      sessionId: "session_1",
      stepIndex: 3,
      turnId: "turn_1",
    });
  });
});
