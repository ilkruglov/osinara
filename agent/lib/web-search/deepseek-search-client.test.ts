/** Search results must come from a completed server tool, never from model-authored links. */
import { describe, expect, it, vi } from "vitest";
import { createDeepSeekSearchClient } from "./deepseek-search-client.js";

const source = { type: "web_search_result", title: "Eve", url: "https://eve.dev/docs", encrypted_content: "not-for-model" };
function response(content: unknown[], extra = {}) {
  return Response.json({ type: "message", stop_reason: "end_turn", content, ...extra });
}
const content = [
  { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "Eve documentation" } },
  { type: "web_search_tool_result", tool_use_id: "search-1", content: [source] },
  { type: "text", text: "Документация Eve", citations: [{ type: "web_search_result_location", url: source.url, cited_text: "Durable agents" }] },
];

describe("DeepSeek search client", () => {
  it("uses the existing key for one Anthropic request and returns bounded sources", async () => {
    const fetch = vi.fn(async () => response(content));
    const search = createDeepSeekSearchClient({ apiKey: "test-secret", fetch });
    await expect(search({ query: "Eve documentation", maxResults: 5, userId: "scope-hash" }))
      .resolves.toMatchObject({ results: [{ title: "Eve", url: source.url, snippet: "Durable agents" }], summary: "Документация Eve" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ "x-api-key": "test-secret" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "deepseek-v4-flash",
      metadata: { user_id: "scope-hash" },
      thinking: { type: "disabled" },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "Eve documentation" }],
    });
  });

  it.each([
    [{ type: "text", text: "I searched: https://eve.dev/docs" }],
    [content[0], { type: "web_search_tool_result", tool_use_id: "search-1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }],
    [content[0], { type: "web_search_tool_result", tool_use_id: "search-1", content: [{ ...source, url: "javascript:alert(1)" }] }],
  ])("refuses absent, failed or invalid search evidence %#", async (...blocks) => {
    const search = createDeepSeekSearchClient({ apiKey: "test", fetch: async () => response(blocks) });
    await expect(search({ query: "test" })).rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_FAILED" });
  });

  it("accepts the official provider's minimal result block without optional title or tool-use metadata", async () => {
    const search = createDeepSeekSearchClient({ apiKey: "test", fetch: async () => response([
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: source.url }] },
    ]) });
    await expect(search({ query: "test" })).resolves.toMatchObject({ results: [{ url: source.url, title: source.url }] });
  });

  it("deduplicates sources and bounds the result count, titles, citations and summary", async () => {
    const search = createDeepSeekSearchClient({ apiKey: "test", fetch: async () => response([
      { type: "web_search_tool_result", content: [
        { ...source, title: "x".repeat(1000) }, source,
        { ...source, url: "https://eve.dev/other" },
      ] },
      { type: "text", text: "s".repeat(9000), citations: [{ url: source.url, cited_text: "c".repeat(2000) }] },
    ]) });
    const result = await search({ query: "test", maxResults: 1 });
    expect(result.results).toEqual([{ title: "x".repeat(300), url: source.url, snippet: "c".repeat(1200) }]);
    expect(result.summary).toHaveLength(8000);
    expect(result.truncated).toBe(true);
  });

  it("returns an honest empty result after an executed search", async () => {
    const search = createDeepSeekSearchClient({ apiKey: "test", fetch: async () => response([
      content[0], { type: "web_search_tool_result", tool_use_id: "search-1", content: [] }, content[2],
    ]) });
    await expect(search({ query: "test" })).resolves.toMatchObject({ results: [], summary: "" });
  });

  it.each([
    { errorContent: [{ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }] },
    { errorContent: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  ])("preserves confirmed sources when a later server search fails %#", async ({ errorContent }) => {
    const search = createDeepSeekSearchClient({ apiKey: "test", fetch: async () => response([
      ...content,
      { type: "web_search_tool_result", content: errorContent },
    ]) });
    await expect(search({ query: "test" })).resolves.toMatchObject({
      results: [{ url: source.url }], truncated: true,
    });
  });

  it("rejects a search containing only an error inside the result array", async () => {
    const search = createDeepSeekSearchClient({ apiKey: "test", fetch: async () => response([
      { type: "web_search_tool_result", content: [{ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }] },
    ]) });
    await expect(search({ query: "test" })).rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_FAILED" });
  });

  it.each([401, 402, 429, 500])("does not retry HTTP %s or expose provider response data", async (status) => {
    const fetch = vi.fn(async () => new Response("sensitive provider details", { status }));
    const search = createDeepSeekSearchClient({ apiKey: "test", fetch });
    await expect(search({ query: "test" })).rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_FAILED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails before network when the key or query is missing", async () => {
    const fetch = vi.fn();
    await expect(createDeepSeekSearchClient({ apiKey: "", fetch })({ query: "test" }))
      .rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_NOT_CONFIGURED" });
    await expect(createDeepSeekSearchClient({ apiKey: "test", fetch })({ query: " " }))
      .rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_INPUT_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates cancellation and bounds a hanging request without retry", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    await expect(createDeepSeekSearchClient({ apiKey: "test", fetch, timeoutMs: 10 })({ query: "test" }))
      .rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_FAILED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
