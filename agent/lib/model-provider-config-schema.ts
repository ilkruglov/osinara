/**
 * Canonical model-provider configuration schema.
 *
 * Exports:
 * - `AgentModelTransport`: supported protocol and reasoning transport union.
 * - `ModelProviderConfig`: validated provider, model, vision, and optional voice contract.
 * - `ModelProviderId`: the supported provider; only DeepSeek since 2 October 2026 (other chat
 *   providers and the Codex subscription gateway were removed as unused).
 * - `parseModelProviderConfig`: validates decoded configuration without filesystem access.
 * - `validateModelProviderRuntimeEnvironment`: enforces config-dependent startup credentials.
 */
import { z } from "zod";

import { AppError } from "./app-error.js";
import { MODEL_PROVIDER_MAX_OUTPUT_TOKENS } from "./model-provider-limits.js";

const modelIdSchema = z.string().trim().min(1).max(200);
const modelProviderIdSchema = z.enum(["deepseek"]);
const reasoningEffortSchema = z.enum(["max", "xhigh", "high", "medium", "low", "minimal"]);
const maxOutputTokensSchema = z.number().int().positive().max(MODEL_PROVIDER_MAX_OUTPUT_TOKENS);
const modelBaseUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "HTTPS is required" });
  }
  if (url.search || url.hash || url.pathname.endsWith("/messages")) {
    context.addIssue({ code: "custom", message: "base URL must not include request details" });
  }
});

const anthropicMessagesTransportSchema = z.object({
  authentication: z.enum(["api-key", "bearer"]),
  baseUrl: modelBaseUrlSchema,
  protocol: z.literal("anthropic-messages"),
  reasoning: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ mode: z.literal("adaptive"), type: z.literal("enabled") }).strict(),
  ]).nullable(),
}).strict();

/** Native DeepSeek Responses API: documented reasoning effort, function tools, exact usage. */
const deepseekResponsesTransportSchema = z.object({
  baseUrl: modelBaseUrlSchema,
  /** Stable model to retry with once when DeepSeek answers that the configured id is unknown (preview aliases expire on a date). */
  fallbackModelId: modelIdSchema.optional(),
  protocol: z.literal("deepseek-responses"),
  reasoning: z.object({
    effort: z.enum(["none", "low", "high", "max"]),
  }).strict(),
}).strict();

const openAiChatCompletionsTransportSchema = z.object({
  baseUrl: modelBaseUrlSchema,
  protocol: z.literal("openai-chat-completions"),
  providerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  reasoning: z.discriminatedUnion("type", [
    z.object({
      format: z.literal("deepseek"),
      type: z.literal("none"),
    }).strict(),
    z.object({
      effort: reasoningEffortSchema,
      format: z.literal("deepseek"),
      type: z.literal("effort"),
    }).strict(),
  ]).nullable(),
}).strict();

const visionModelSchema = z.discriminatedUnion("supportsImageInput", [
  z.object({ supportsImageInput: z.literal(false) }).strict(),
  z.object({
    id: modelIdSchema,
    maxOutputTokens: maxOutputTokensSchema,
    // The vision model may need a different reasoning depth than the text model: DeepSeek
    // vision-exp at effort max spent 28k reasoning tokens and four minutes on one photo.
    reasoningEffort: z.enum(["none", "low", "high", "max"]).optional(),
    supportsImageInput: z.literal(true),
  }).strict(),
]);

const modelProviderConfigSchema = z.object({
  agent: z.object({
    models: z.object({
      primary: z.object({
        contextWindowTokens: z.number().int().positive(),
        id: modelIdSchema,
        maxOutputTokens: maxOutputTokensSchema,
      }).strict(),
      vision: visionModelSchema,
    }).strict(),
    transport: z.discriminatedUnion("protocol", [
      anthropicMessagesTransportSchema,
      deepseekResponsesTransportSchema,
      openAiChatCompletionsTransportSchema,
    ]),
  }).strict(),
  provider: modelProviderIdSchema,
  schemaVersion: z.literal(4),
  voice: z.discriminatedUnion("enabled", [
    z.object({ enabled: z.literal(false) }).strict(),
    z.object({ enabled: z.literal(true), transcriptionModelId: modelIdSchema }).strict(),
  ]),
}).strict().superRefine((config, context) => {
  const transport = config.agent.transport;
  const expectedBaseUrl = transport.protocol === "anthropic-messages"
    ? "https://api.deepseek.com/anthropic"
    : "https://api.deepseek.com";
  if (transport.baseUrl !== expectedBaseUrl) {
    context.addIssue({
      code: "custom",
      message: "provider transport does not match",
      path: ["agent", "transport"],
    });
  }

  // DeepSeek serves the same models over Responses, Chat Completions and an Anthropic-compatible
  // endpoint; each must use DeepSeek's own request format.
  const chatCompletions = transport.protocol === "openai-chat-completions" &&
    transport.providerName === "deepseek";
  const anthropicMessages = transport.protocol === "anthropic-messages";
  const responses = transport.protocol === "deepseek-responses";
  if (!chatCompletions && !anthropicMessages && !responses) {
    context.addIssue({ code: "custom", message: "DeepSeek transport mismatch", path: ["agent", "transport"] });
  }
});

export type AgentModelTransport = z.infer<typeof modelProviderConfigSchema>["agent"]["transport"];
export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;

export function parseModelProviderConfig(value: unknown): ModelProviderConfig {
  const parsed = modelProviderConfigSchema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new AppError(
      "AGENT_MODEL_PROVIDER_CONFIG_INVALID",
      `Некорректная конфигурация моделей: ${fields}`,
    );
  }
  return parsed.data;
}

/** Voice is optional, but an enabled Groq route must have its own non-blank startup credential. */
export function validateModelProviderRuntimeEnvironment(
  configValue: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): { GROQ_API_KEY: string | undefined } {
  const config = parseModelProviderConfig(configValue);
  const groqApiKey = environment.GROQ_API_KEY;
  if (config.voice.enabled && (groqApiKey === undefined || groqApiKey.trim().length === 0)) {
    throw new AppError(
      "AGENT_GROQ_API_KEY_REQUIRED",
      "Для включённого распознавания голосовых сообщений задайте GROQ_API_KEY",
    );
  }
  return { GROQ_API_KEY: groqApiKey };
}
