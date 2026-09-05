import { describe, expect, it, vi } from "vitest";
import { searchPublicWeb } from "./conversation-web-tools.js";

describe("provider-independent web search", () => {
  it.each(["application/json", "text/event-stream"])("reads a bounded %s Exa response without an API key", async (type) => {
    const fetchMock = vi.fn(async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      expect(request.params).toEqual({ name: "web_search_exa", arguments: { query: "Telegram API", numResults: 5 } });
      const json = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Source: https://core.telegram.org/bots/api" }] } });
      return new Response(type === "application/json" ? json : `event: message\ndata: ${json}\n\n`, { headers: { "content-type": type } });
    });
    await expect(searchPublicWeb({ query: "Telegram API" }, fetchMock)).resolves.toMatchObject({ content: expect.stringContaining("https://core.telegram.org"), truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([400, 429, 500])("does not retry HTTP %s or fabricate results", async (status) => {
    const fetchMock = vi.fn(async () => new Response("failed", { status }));
    await expect(searchPublicWeb({ query: "test" }, fetchMock)).rejects.toThrow("AGENT_WEB_SEARCH_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves a timeout as the cause and reports no invented results", async () => {
    const timeout = new Error("request timeout");
    await expect(searchPublicWeb({ query: "test" }, vi.fn().mockRejectedValue(timeout))).rejects.toMatchObject({ cause: timeout });
  });
  it("rejects a mismatched response identity", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "wrong", result: { content: [] } }));
    await expect(searchPublicWeb({ query: "test" }, fetchMock)).rejects.toThrow("AGENT_WEB_SEARCH_FAILED");
  });
});
