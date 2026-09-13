/**
 * Provider search tool guard tests.
 *
 * Constructs covered:
 * - A `web_search` returned as a plain function call is re-labelled provider-executed and closed
 *   with an error result, in a non-streaming result and through the transport stream.
 * - A genuine provider-executed search call and ordinary function calls pass untouched.
 */
import type { LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText, stepCountIs, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createConfiguredLanguageModel } from "./model-transport.js";
import {
  closeStrayProviderSearchCalls,
  PROVIDER_SEARCH_FUNCTION_CALL_CODE,
} from "./provider-search-tool-call.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("closeStrayProviderSearchCalls", () => {
  it("closes only a search call that no local executor can answer", () => {
    const content: LanguageModelV4Content[] = [
      { input: "{}", toolCallId: "call_search", toolName: "web_search", type: "tool-call" },
      { input: "{}", providerExecuted: true, toolCallId: "ws_native", toolName: "web_search", type: "tool-call" },
      { input: "{\"pattern\":\"*\"}", toolCallId: "call_glob", toolName: "glob", type: "tool-call" },
    ];
    const stray: string[] = [];

    const closed = closeStrayProviderSearchCalls(content, (id) => stray.push(id));

    expect(stray).toEqual(["call_search"]);
    expect(closed).toEqual([
      { input: "{}", providerExecuted: true, toolCallId: "call_search", toolName: "web_search", type: "tool-call" },
      expect.objectContaining({ isError: true, toolCallId: "call_search", type: "tool-result" }),
      content[1],
      content[2],
    ]);
    expect(JSON.stringify(closed[1])).toContain(PROVIDER_SEARCH_FUNCTION_CALL_CODE);
  });
});

describe("transport stream", () => {
  it("executes local search and sends its sources back to the model", async () => {
    const requests: Record<string, unknown>[] = [];
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const output = requests.length === 1
          ? [{ type: "function_call", id: "fc_1", call_id: "call_search", name: "web_search", arguments: '{"query":"Eve documentation"}', status: "completed" }]
          : [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Найдена документация", annotations: [] }] }];
        return Response.json({
          id: `resp_${requests.length}`, created_at: 1, model: "deepseek-v4-flash", object: "response",
          status: "completed", output,
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        });
      },
      maxOutputTokens: 8_000,
      modelId: "deepseek-v4-flash",
      transport: { baseUrl: "https://api.deepseek.com", protocol: "deepseek-responses", reasoning: { effort: "high" } },
    });
    const execute = vi.fn(async (_input: { query: string }) => ({ results: [{ title: "Eve", url: "https://eve.dev/docs" }] }));
    const result = await generateText({
      model, maxRetries: 0, prompt: "Найди документацию Eve", stopWhen: stepCountIs(2),
      tools: { web_search: tool({ inputSchema: z.object({ query: z.string() }), execute }) },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ query: "Eve documentation" });
    expect(requests[0]?.tools).toEqual([expect.objectContaining({ type: "function", name: "web_search" })]);
    expect(JSON.stringify(requests[1]?.input)).toContain("https://eve.dev/docs");
    expect(result.text).toBe("Найдена документация");
  });

  it.each([false, true])("handles a streamed DeepSeek search call with a local executor: %s", async (local) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = [
      { type: "response.created", response: { id: "resp_1", created_at: 1, model: "deepseek-v4-flash", object: "response", output: [], status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_search", name: "web_search", arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{}" },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_search", name: "web_search", arguments: "{}", status: "completed" } },
      { type: "response.completed", response: {
        id: "resp_1", created_at: 1, model: "deepseek-v4-flash", object: "response", status: "completed",
        output: [{ type: "function_call", id: "fc_1", call_id: "call_search", name: "web_search", arguments: "{}", status: "completed" }],
        usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 25 },
      } },
    ];
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async () => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
      maxOutputTokens: 8_000,
      modelId: "deepseek-v4-flash",
      transport: { baseUrl: "https://api.deepseek.com", protocol: "deepseek-responses", reasoning: { effort: "high" } },
    });

    const { stream } = await model.doStream({
      prompt: [{ content: [{ text: "Найди", type: "text" }], role: "user" }],
      ...(local ? { tools: [{ type: "function", name: "web_search", inputSchema: { type: "object", properties: {} } }] } : {}),
    } as LanguageModelV4CallOptions);
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of stream) parts.push(part);

    const call = parts.find((part) => part.type === "tool-call");
    if (local) {
      expect(call).toMatchObject({ toolCallId: "call_search", toolName: "web_search" });
      expect(call).not.toMatchObject({ providerExecuted: true });
      expect(parts.find((part) => part.type === "tool-input-start")).not.toMatchObject({ providerExecuted: true });
      expect(parts.filter((part) => part.type === "tool-result")).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
      return;
    }
    expect(call).toMatchObject({ providerExecuted: true, toolCallId: "call_search", toolName: "web_search" });
    const result = parts.find((part) => part.type === "tool-result");
    expect(result).toMatchObject({ isError: true, toolCallId: "call_search", toolName: "web_search" });
    expect(parts.findIndex((part) => part.type === "tool-result")).toBeGreaterThan(parts.findIndex((part) => part.type === "tool-call"));
    expect(parts.find((part) => part.type === "tool-input-start")).toMatchObject({ providerExecuted: true });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(PROVIDER_SEARCH_FUNCTION_CALL_CODE));
  });
});
