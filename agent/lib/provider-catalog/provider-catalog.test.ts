/**
 * Provider catalog boundary tests.
 *
 * Constructs covered:
 * - `fetchProviderCatalog`: fetches provider model catalogs through an injected fetch.
 * - Provider authentication, endpoint selection, HTTP handling, and bounded timeout behavior.
 * - DeepSeek parsing without fabricated live availability.
 * - Models.dev enrichment, strict live-ID intersection, and installer-ready model filtering.
 * - Stable `AppError` codes for invalid input and malformed provider responses.
 */
import { describe, expect, it, vi } from "vitest";

import {
  fetchProviderCatalog,
  type ProviderCatalogFetch,
  type ProviderCatalogModel,
} from "./provider-catalog.js";
import {
  createFetch,
  expectAppError,
  jsonResponse,
  REQUEST_TIMEOUT_MS,
} from "./provider-catalog-test-helpers.js";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** Routes injected requests by URL so live and metadata responses remain independently testable. */
function createCatalogFetch(responses: Record<string, Response>): ProviderCatalogFetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = responses[url];
    if (!response) throw new Error(`Unexpected test URL: ${url}`);
    return response;
  });
}

describe("fetchProviderCatalog", () => {
  it("requires authentication before fetching the DeepSeek catalog", async () => {
    const fetch = createFetch(jsonResponse({ object: "list", data: [] }));

    await expectAppError(
      fetchProviderCatalog({ fetch, providerId: "deepseek", timeoutMs: REQUEST_TIMEOUT_MS }),
      "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED",
      "Для загрузки каталога deepseek нужен API-ключ",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a blank required API key before fetching", async () => {
    const fetch = createFetch(jsonResponse({ object: "list", data: [] }));

    await expectAppError(
      fetchProviderCatalog({
        apiKey: "   ",
        fetch,
        providerId: "deepseek",
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED",
      "Для загрузки каталога deepseek нужен API-ключ",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("intersects DeepSeek live IDs with complete models.dev metadata", async () => {
    const fetch = createCatalogFetch({
      "https://api.deepseek.com/models": jsonResponse({
        object: "list",
        data: [
          { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
          { id: "live-without-metadata", object: "model", owned_by: "deepseek" },
          { id: "no-tools", object: "model", owned_by: "deepseek" },
          { id: "incomplete-limits", object: "model", owned_by: "deepseek" },
          { id: "no-text", object: "model", owned_by: "deepseek" },
        ],
      }),
      [MODELS_DEV_URL]: jsonResponse({
        deepseek: {
          id: "deepseek",
          models: {
            "deepseek-v4-flash": {
              id: "deepseek-v4-flash",
              limit: { context: 1_000_000, output: 384_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "DeepSeek V4 Flash",
              reasoning_options: [
                { type: "toggle" },
                { type: "effort", values: ["low", "high", "max"] },
              ],
              tool_call: true,
            },
            "metadata-only": {
              id: "metadata-only",
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "Metadata Only",
              reasoning_options: [],
              tool_call: true,
            },
            "no-tools": {
              id: "no-tools",
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "No Tools",
              reasoning_options: [],
              tool_call: false,
            },
            "incomplete-limits": {
              id: "incomplete-limits",
              limit: { context: 64_000 },
              modalities: { input: ["text"], output: ["text"] },
              name: "Incomplete Limits",
              reasoning_options: [],
              tool_call: true,
            },
            "no-text": {
              id: "no-text",
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ["image"], output: ["text"] },
              name: "No Text",
              reasoning_options: [],
              tool_call: true,
            },
          },
          name: "DeepSeek",
        },
      }),
    });

    const models = await fetchProviderCatalog({
      apiKey: "deepseek-secret",
      fetch,
      providerId: "deepseek",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/models", {
      headers: { authorization: "Bearer deepseek-secret" },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenCalledWith(MODELS_DEV_URL, {
      headers: {},
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(models).toEqual<ProviderCatalogModel[]>([
      {
        contextWindowTokens: 1_000_000,
        defaultReasoningOption: null,
        displayName: "DeepSeek V4 Flash",
        id: "deepseek-v4-flash",
        maxOutputTokens: 128_000,
        protocol: "openai-chat-completions",
        reasoningOptions: [
          { type: "none" },
          { effort: "low", type: "effort" },
          { effort: "high", type: "effort" },
          { effort: "max", type: "effort" },
        ],
        supportsImageInput: false,
        supportsTools: true,
      },
    ]);
  });
});
