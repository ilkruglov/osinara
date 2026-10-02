/**
 * Installer model-provider config builder tests.
 *
 * Constructs covered:
 * - `buildModelProviderConfig`: maps installer-ready catalog metadata to exact schema v4.
 * - The DeepSeek Chat Completions endpoint, provider name and reasoning format; a catalog protocol
 *   that contradicts it is refused.
 * - Canonical reasoning membership and fail-fast model capability validation.
 */
import { describe, expect, it } from "vitest";

import { parseModelProviderConfig } from "../model-provider-config-schema.js";
import { buildModelProviderConfig } from "./model-provider-config-builder.js";
import type {
  ProviderCatalogModel,
  ReasoningSelection,
} from "./provider-catalog.js";

function catalogModel(
  overrides: Partial<ProviderCatalogModel> = {},
): ProviderCatalogModel {
  return {
    contextWindowTokens: 64_000,
    defaultReasoningOption: null,
    displayName: "Provider model",
    id: "provider/model",
    maxOutputTokens: 8_000,
    protocol: "openai-chat-completions",
    reasoningOptions: [{ type: "none" }, { effort: "high", type: "effort" }],
    supportsImageInput: false,
    supportsTools: true,
    ...overrides,
  };
}

describe("buildModelProviderConfig", () => {
  it.each([
    {
      expected: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-completions",
        providerName: "deepseek",
        reasoning: { effort: "high", format: "deepseek", type: "effort" },
      },
      model: catalogModel(),
      reasoning: { effort: "high", type: "effort" },
    },
    {
      expected: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-completions",
        providerName: "deepseek",
        reasoning: { format: "deepseek", type: "none" },
      },
      model: catalogModel({ reasoningOptions: [{ type: "none" }] }),
      reasoning: { type: "none" },
    },
    {
      expected: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-completions",
        providerName: "deepseek",
        reasoning: null,
      },
      model: catalogModel({ reasoningOptions: [] }),
      reasoning: null,
    },
  ] satisfies Array<{
    expected: object;
    model: ProviderCatalogModel;
    reasoning: ReasoningSelection | null;
  }>)("builds the exact DeepSeek transport for reasoning $reasoning", ({ expected, model, reasoning }) => {
    const config = buildModelProviderConfig("deepseek", model, reasoning, false);

    expect(config.provider).toBe("deepseek");
    expect(config.agent.transport).toEqual(expected);
    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it("uses the same image-capable model for primary and vision and fixed voice model", () => {
    const model = catalogModel({ supportsImageInput: true });
    const config = buildModelProviderConfig("deepseek", model, { type: "none" }, true);

    expect(config.agent.models).toEqual({
      primary: { contextWindowTokens: 64_000, id: "provider/model", maxOutputTokens: 8_000 },
      vision: { id: "provider/model", maxOutputTokens: 8_000, supportsImageInput: true },
    });
    expect(config.voice).toEqual({
      enabled: true,
      transcriptionModelId: "whisper-large-v3-turbo",
    });
    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it("uses the unavailable vision and disabled voice schema variants", () => {
    const config = buildModelProviderConfig(
      "deepseek",
      catalogModel({ reasoningOptions: [] }),
      null,
      false,
    );

    expect(config.agent.models.vision).toEqual({ supportsImageInput: false });
    expect(config.voice).toEqual({ enabled: false });
  });

  it("compares selected reasoning canonically rather than by object identity or key order", () => {
    const selected = { type: "effort", effort: "high" } as const;
    const model = catalogModel({ reasoningOptions: [{ effort: "high", type: "effort" }] });

    expect(() => buildModelProviderConfig("deepseek", model, selected, false)).not.toThrow();
    expect(() => buildModelProviderConfig(
      "deepseek",
      model,
      { effort: "low", type: "effort" },
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE");
  });

  it("rejects null when the catalog requires an explicit reasoning selection", () => {
    expect(() => buildModelProviderConfig("deepseek", catalogModel(), null, false))
      .toThrow("AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE");
  });

  it("rejects malformed injected reasoning metadata with a stable error", () => {
    const model = catalogModel({ reasoningOptions: [null] as never });

    expect(() => buildModelProviderConfig("deepseek", model, null, false))
      .toThrow("AGENT_PROVIDER_CONFIG_REASONING_INVALID");
  });

  it.each([
    ["missing context", { contextWindowTokens: null }],
    ["non-positive context", { contextWindowTokens: 0 }],
    ["missing output", { maxOutputTokens: null }],
    ["non-positive output", { maxOutputTokens: -1 }],
    ["output above runtime cap", { maxOutputTokens: 128_001 }],
    ["unknown image support", { supportsImageInput: null }],
    ["missing tool support", { supportsTools: false }],
  ])("rejects installer-unsafe metadata: %s", (_case, overrides) => {
    expect(() => buildModelProviderConfig(
      "deepseek",
      catalogModel(overrides),
      null,
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_MODEL_INVALID");
  });

  it("rejects a model protocol that contradicts its fixed provider transport", () => {
    expect(() => buildModelProviderConfig(
      "deepseek",
      catalogModel({ protocol: "anthropic-messages" }),
      null,
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_PROTOCOL_INVALID");
  });

  it("rejects adaptive enabled reasoning on the DeepSeek Chat Completions transport", () => {
    const model = catalogModel({
      reasoningOptions: [{ mode: "adaptive", type: "enabled" }],
    });

    expect(() => buildModelProviderConfig(
      "deepseek",
      model,
      { mode: "adaptive", type: "enabled" },
      false,
    )).toThrow("AGENT_PROVIDER_CONFIG_REASONING_UNSUPPORTED");
  });
});
