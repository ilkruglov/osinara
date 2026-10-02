/**
 * Installer-ready model-provider configuration builder.
 *
 * Exports:
 * - `buildModelProviderConfig`: converts one selected catalog model into validated schema v4.
 *
 * Key constructs:
 * - Canonical structural reasoning comparison independent of object identity and key order.
 * - DeepSeek Chat Completions endpoint and reasoning mapping (the only provider since 2 October 2026).
 * - Fail-fast validation of model limits and required agent capabilities.
 */
import {
  parseModelProviderConfig,
  type AgentModelTransport,
  type ModelProviderConfig,
} from "../model-provider-config-schema.js";
import { AppError } from "../app-error.js";
import { MODEL_PROVIDER_MAX_OUTPUT_TOKENS } from "../model-provider-limits.js";
import type {
  ProviderCatalogModel,
  ProviderId,
  ProviderProtocol,
  ReasoningSelection,
} from "./provider-catalog-types.js";

const VOICE_TRANSCRIPTION_MODEL_ID = "whisper-large-v3-turbo";
const REASONING_EFFORTS = new Set([
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
]);

/** Validates and serializes the closed reasoning union into one canonical comparison key. */
function canonicalReasoning(selection: ReasoningSelection): string {
  if (typeof selection !== "object" || selection === null || !("type" in selection)) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_REASONING_INVALID",
      "Выбран некорректный вариант рассуждений для модели",
    );
  }
  const keys = Object.keys(selection);
  if (selection.type === "none" && keys.length === 1) return "none";
  if (
    selection.type === "effort" &&
    keys.length === 2 &&
    REASONING_EFFORTS.has(selection.effort)
  ) {
    return `effort:${selection.effort}`;
  }
  if (
    selection.type === "enabled" &&
    keys.length === 2 &&
    (selection.mode === "adaptive" || selection.mode === "enabled")
  ) {
    return `enabled:${selection.mode}`;
  }
  throw new AppError(
    "AGENT_PROVIDER_CONFIG_REASONING_INVALID",
    "Выбран некорректный вариант рассуждений для модели",
  );
}

/** Catalog output is an integration input, so required installer fields are checked at runtime. */
function validateInstallerReadyModel(model: ProviderCatalogModel): void {
  const validContext = Number.isInteger(model.contextWindowTokens)
    && model.contextWindowTokens !== null
    && model.contextWindowTokens > 0;
  const validOutput = Number.isInteger(model.maxOutputTokens)
    && model.maxOutputTokens !== null
    && model.maxOutputTokens > 0
    && model.maxOutputTokens <= MODEL_PROVIDER_MAX_OUTPUT_TOKENS;
  const validId = typeof model.id === "string"
    && model.id.trim().length > 0
    && model.id.length <= 200;
  const validCapabilities = model.supportsTools === true
    && typeof model.supportsImageInput === "boolean";
  if (!validContext || !validOutput || !validId || !validCapabilities) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_MODEL_INVALID",
      "Выбранная модель не содержит обязательные лимиты или возможности для установки",
    );
  }

  // Every catalog option must be structurally valid before membership can be trusted.
  if (!Array.isArray(model.reasoningOptions)) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_MODEL_INVALID",
      "Выбранная модель содержит некорректный список вариантов рассуждений",
    );
  }
  for (const option of model.reasoningOptions) canonicalReasoning(option);
}

/** The installer builds DeepSeek over Chat Completions; contradictory catalog metadata is refused. */
function requireProviderProtocol(providerId: ProviderId, modelProtocol: ProviderProtocol): void {
  if (modelProtocol !== "openai-chat-completions") {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_PROTOCOL_INVALID",
      `Протокол модели не соответствует поставщику ${providerId}`,
    );
  }
}

/** Null means the catalog exposes no control; the provider keeps its documented model behavior. */
function requireReasoningSelection(
  model: ProviderCatalogModel,
  selected: ReasoningSelection | null,
): ReasoningSelection | null {
  if (selected === null && model.reasoningOptions.length === 0) return null;
  if (selected === null) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE",
      "Для выбранной модели необходимо выбрать доступный вариант рассуждений",
    );
  }
  const selectedKey = canonicalReasoning(selected);
  const available = model.reasoningOptions.some(
    (option) => canonicalReasoning(option) === selectedKey,
  );
  if (!available) {
    throw new AppError(
      "AGENT_PROVIDER_CONFIG_REASONING_NOT_AVAILABLE",
      "Выбранный вариант рассуждений недоступен для этой модели",
    );
  }
  return selected;
}

function openAiReasoning(
  reasoning: ReasoningSelection | null,
): Extract<AgentModelTransport, { protocol: "openai-chat-completions" }>['reasoning'] {
  if (reasoning === null) return null;
  if (reasoning.type === "none") return { format: "deepseek", type: "none" };
  if (reasoning.type === "effort") return { effort: reasoning.effort, format: "deepseek", type: "effort" };
  throw new AppError(
    "AGENT_PROVIDER_CONFIG_REASONING_UNSUPPORTED",
    "Выбранный вариант рассуждений не поддерживается протоколом OpenAI",
  );
}

/** Builds only transports accepted by the canonical schema v4 contract. */
function buildTransport(reasoning: ReasoningSelection | null): AgentModelTransport {
  return {
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-chat-completions",
    providerName: "deepseek",
    reasoning: openAiReasoning(reasoning),
  };
}

/** Converts catalog metadata to schema v4 and proves the result with the canonical parser. */
export function buildModelProviderConfig(
  providerId: ProviderId,
  model: ProviderCatalogModel,
  reasoning: ReasoningSelection | null,
  voiceEnabled: boolean,
): ModelProviderConfig {
  validateInstallerReadyModel(model);
  requireProviderProtocol(providerId, model.protocol);
  const selectedReasoning = requireReasoningSelection(model, reasoning);
  const primary = {
    contextWindowTokens: model.contextWindowTokens as number,
    id: model.id,
    maxOutputTokens: model.maxOutputTokens as number,
  };

  // Vision intentionally reuses the selected primary model; no second implicit model is invented.
  const config = {
    agent: {
      models: {
        primary,
        vision: model.supportsImageInput
          ? {
              id: model.id,
              maxOutputTokens: model.maxOutputTokens as number,
              supportsImageInput: true as const,
            }
          : { supportsImageInput: false as const },
      },
      transport: buildTransport(selectedReasoning),
    },
    provider: providerId,
    schemaVersion: 4 as const,
    voice: voiceEnabled
      ? { enabled: true as const, transcriptionModelId: VOICE_TRANSCRIPTION_MODEL_ID }
      : { enabled: false as const },
  };
  return parseModelProviderConfig(config);
}
