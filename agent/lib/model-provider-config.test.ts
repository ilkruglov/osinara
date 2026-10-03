/**
 * Runtime model-provider configuration tests.
 *
 * Constructs covered:
 * - `parseModelProviderConfig`: validates protocol-native agent transports and model IDs.
 * - DeepSeek is the only provider: Responses, Chat Completions and the Anthropic-compatible
 *   endpoint, each on its fixed DeepSeek base URL; Chat Completions only with DeepSeek's own
 *   provider name and reasoning format.
 * - Removed chat providers and the plain-HTTP internal gateway are rejected.
 * - Required endpoint, authentication, thinking, capability, and context metadata fail fast.
 * - Voice-enabled startup requires an explicit Groq credential.
 * - Canonical runtime output limits reject values above the application-tested cap.
 * - Active schema is the host-mounted provider selection contract.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseModelProviderConfig,
  validateModelProviderRuntimeEnvironment,
} from "./model-provider-config-schema.js";

const validConfig = {
  agent: {
    models: {
      primary: { contextWindowTokens: 1_000_000, id: "deepseek-flash", maxOutputTokens: 128_000 },
      vision: { id: "deepseek-flash", maxOutputTokens: 128_000, supportsImageInput: true },
    },
    transport: {
      baseUrl: "https://api.deepseek.com",
      protocol: "openai-chat-completions",
      providerName: "deepseek",
      reasoning: { effort: "high", format: "deepseek", type: "effort" },
    },
  },
  provider: "deepseek",
  schemaVersion: 4,
  voice: { enabled: true, transcriptionModelId: "whisper-large-v3-turbo" },
} as const;

describe("parseModelProviderConfig", () => {
  it("loads the same active schema that production mounts for the agent", async () => {
    const active = JSON.parse(await readFile("config/agent-model-providers.json", "utf8"));

    expect(parseModelProviderConfig(active)).toEqual(active);
  });

  it("accepts protocol-native primary, vision, and voice model selection", () => {
    expect(parseModelProviderConfig(validConfig)).toEqual(validConfig);
  });

  it("accepts a separate reasoning effort for silent memory review on the primary model", () => {
    const primary = { ...validConfig.agent.models.primary, memoryReviewReasoningEffort: "low" };
    const config = { ...validConfig, agent: { ...validConfig.agent, models: { ...validConfig.agent.models, primary } } };
    expect(parseModelProviderConfig(config)).toEqual(config);
    expect(() => parseModelProviderConfig({
      ...config,
      agent: { ...config.agent, models: { ...config.agent.models, primary: { ...primary, memoryReviewReasoningEffort: "medium" } } },
    })).toThrow();
  });

  it("accepts the native DeepSeek Responses transport only on the DeepSeek host", () => {
    const responses = {
      ...validConfig,
      agent: {
        models: {
          primary: { contextWindowTokens: 1_000_000, id: "deepseek-v4-flash", maxOutputTokens: 128_000 },
          vision: { supportsImageInput: false },
        },
        transport: {
          baseUrl: "https://api.deepseek.com",
          protocol: "deepseek-responses",
          reasoning: { effort: "none" },
        },
      },
      provider: "deepseek",
    } as const;
    expect(parseModelProviderConfig(responses)).toEqual(responses);
    expect(() => parseModelProviderConfig({
      ...responses,
      agent: { ...responses.agent, transport: { ...responses.agent.transport, baseUrl: "https://api.deepseek.com/anthropic" } },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...responses,
      agent: { ...responses.agent, transport: { ...responses.agent.transport, reasoning: { effort: "medium" } } },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts DeepSeek over its Anthropic-compatible endpoint as well as Chat Completions", () => {
    const deepseekAnthropic = {
      ...validConfig,
      agent: {
        models: {
          primary: { contextWindowTokens: 1_000_000, id: "deepseek-v4-flash", maxOutputTokens: 128_000 },
          vision: { supportsImageInput: false },
        },
        transport: {
          authentication: "api-key",
          baseUrl: "https://api.deepseek.com/anthropic",
          protocol: "anthropic-messages",
          reasoning: { mode: "adaptive", type: "enabled" },
        },
      },
      provider: "deepseek",
    } as const;
    expect(parseModelProviderConfig(deepseekAnthropic)).toEqual(deepseekAnthropic);
    expect(() => parseModelProviderConfig({
      ...deepseekAnthropic,
      agent: {
        ...deepseekAnthropic.agent,
        transport: { ...deepseekAnthropic.agent.transport, baseUrl: "https://proxy.example/anthropic" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    expect(() => parseModelProviderConfig({
      ...deepseekAnthropic,
      agent: {
        ...deepseekAnthropic.agent,
        transport: { ...deepseekAnthropic.agent.transport, compatibility: "minimax-anthropic" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("accepts Chat Completions only with DeepSeek's provider name and reasoning format", () => {
    for (const reasoning of [null, { format: "deepseek", type: "none" }] as const) {
      const config = { ...validConfig, agent: { ...validConfig.agent, transport: { ...validConfig.agent.transport, reasoning } } };
      expect(parseModelProviderConfig(config)).toEqual(config);
    }
    for (const transport of [
      { ...validConfig.agent.transport, providerName: "openrouter" },
      { ...validConfig.agent.transport, baseUrl: "https://openrouter.ai/api/v1" },
      { ...validConfig.agent.transport, reasoning: { effort: "high", format: "reasoning-effort", type: "effort" } },
      { ...validConfig.agent.transport, reasoning: { effort: "high", format: "reasoning-object", type: "effort" } },
    ]) {
      expect(() => parseModelProviderConfig({
        ...validConfig,
        agent: { ...validConfig.agent, transport },
      })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
    }
  });

  it.each(["codex-subscription", "groq", "minimax", "neuraldeep", "opencode-go", "openrouter"])(
    "rejects the removed chat provider %s",
    (provider) => {
      expect(() => parseModelProviderConfig({ ...validConfig, provider })).toThrow(
        "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
      );
    },
  );

  it("rejects the former plain-HTTP internal gateway", () => {
    expect(() => parseModelProviderConfig({
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: { ...validConfig.agent.transport, baseUrl: "http://cli-proxy-api:8317/v1" },
      },
    })).toThrow("AGENT_MODEL_PROVIDER_CONFIG_INVALID");
  });

  it("requires GROQ_API_KEY at startup only when voice is enabled", () => {
    expect(() => validateModelProviderRuntimeEnvironment(validConfig, {})).toThrow(
      "AGENT_GROQ_API_KEY_REQUIRED: Для включённого распознавания голосовых сообщений задайте GROQ_API_KEY",
    );
    expect(() => validateModelProviderRuntimeEnvironment(validConfig, {
      GROQ_API_KEY: "   ",
    })).toThrow("AGENT_GROQ_API_KEY_REQUIRED");
    expect(validateModelProviderRuntimeEnvironment(validConfig, {
      GROQ_API_KEY: "groq-secret",
    })).toEqual({ GROQ_API_KEY: "groq-secret" });
    expect(validateModelProviderRuntimeEnvironment({
      ...validConfig,
      voice: { enabled: false },
    }, {})).toEqual({ GROQ_API_KEY: undefined });
  });

  it("accepts explicit DeepSeek thinking and an unavailable vision capability", () => {
    const config = {
      ...validConfig,
      agent: {
        models: {
          primary: {
            contextWindowTokens: 1_000_000,
            id: "deepseek-v4-flash",
            maxOutputTokens: 128_000,
          },
          vision: { supportsImageInput: false },
        },
        transport: {
          baseUrl: "https://api.deepseek.com",
          protocol: "openai-chat-completions",
          providerName: "deepseek",
          reasoning: { effort: "high", format: "deepseek", type: "effort" },
        },
      },
      provider: "deepseek",
    } as const;

    expect(parseModelProviderConfig(config)).toEqual(config);
  });

  it.each([
    { ...validConfig, schemaVersion: 3 },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        models: {
          ...validConfig.agent.models,
          primary: { contextWindowTokens: 0, id: "deepseek-flash", maxOutputTokens: 128_000 },
        },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        models: {
          ...validConfig.agent.models,
          vision: { id: "", maxOutputTokens: 128_000, supportsImageInput: true },
        },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: { ...validConfig.agent.transport, baseUrl: "http://api.deepseek.com" },
      },
    },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          ...validConfig.agent.transport,
          baseUrl: "https://api.deepseek.com/messages",
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
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        transport: {
          baseUrl: "https://api.deepseek.com",
          protocol: "openai-chat-completions",
          providerName: "deepseek",
        },
      },
    },
    { ...validConfig, agent: { ...validConfig.agent, unexpected: true } },
    { ...validConfig, provider: "unknown" },
    { ...validConfig, voice: { enabled: true, transcriptionModelId: "" } },
    {
      ...validConfig,
      agent: {
        ...validConfig.agent,
        models: {
          ...validConfig.agent.models,
          primary: { ...validConfig.agent.models.primary, maxOutputTokens: 128_001 },
        },
      },
    },
  ])("rejects invalid or ambiguous required config %#", (input) => {
    expect(() => parseModelProviderConfig(input)).toThrow(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
    );
  });
});
