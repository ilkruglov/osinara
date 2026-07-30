/**
 * Runtime model-provider configuration tests.
 *
 * Constructs covered:
 * - `parseModelProviderConfig`: validates protocol-native agent transports and model IDs.
 * - Anthropic Messages and OpenAI Chat Completions remain provider-name independent.
 * - Required endpoint, authentication, thinking, and context metadata fail fast.
 * - Active schema remains separate from the host-mounted deployment compatibility file.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseModelProviderConfig } from "./model-provider-config.js";

const validConfig = {
  agent: {
    models: {
      primary: { contextWindowTokens: 1_000_000, id: "MiniMax-M3", maxOutputTokens: 128_000 },
      vision: { id: "MiniMax-M3", maxOutputTokens: 128_000 },
    },
    transport: {
      authentication: "bearer",
      baseUrl: "https://api.minimax.io/anthropic/v1",
      protocol: "anthropic-messages",
      thinking: { type: "adaptive" },
    },
  },
  schemaVersion: 2,
  voice: { transcriptionModelId: "whisper-large-v3-turbo" },
} as const;

describe("parseModelProviderConfig", () => {
  it("keeps the active transport config separate from deployment compatibility", async () => {
    const active = JSON.parse(await readFile("config/agent-model-providers.json", "utf8"));
    const compatibility = JSON.parse(await readFile("config/model-providers.json", "utf8"));

    expect(parseModelProviderConfig(active)).toEqual(active);
    expect(compatibility).toMatchObject({ schemaVersion: 1 });
    expect(() => parseModelProviderConfig(compatibility)).toThrow(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
    );
  });

  it("accepts protocol-native primary, vision, and voice model selection", () => {
    expect(parseModelProviderConfig(validConfig)).toEqual(validConfig);
  });

  it("accepts a generic OpenAI-compatible transport without provider branching", () => {
    const config = {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          baseUrl: "https://openrouter.ai/api/v1",
          protocol: "openai-chat-completions",
          providerName: "openrouter",
        },
      },
    };

    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it.each([
    { ...validConfig, schemaVersion: 1 },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        models: {
          ...validConfig.agent.models,
          primary: { contextWindowTokens: 0, id: "MiniMax-M3", maxOutputTokens: 128_000 },
        },
      },
    },
    {
      ...validConfig,
      agent: { ...validConfig.agent, models: { ...validConfig.agent.models, vision: { id: "" } } },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: { ...validConfig.agent.transport, baseUrl: "http://api.minimax.io/v1" },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          ...validConfig.agent.transport,
          baseUrl: "https://api.minimax.io/anthropic/v1/messages",
        },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: { ...validConfig.agent.transport, protocol: "unknown" },
      },
    },
    { ...validConfig, agent: { ...validConfig.agent, unexpected: true } },
    { ...validConfig, voice: { transcriptionModelId: "" } },
  ])("rejects invalid or ambiguous required config %#", (input) => {
    expect(() => parseModelProviderConfig(input)).toThrow(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
    );
  });
});
