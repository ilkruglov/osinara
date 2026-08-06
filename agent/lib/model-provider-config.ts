/**
 * Runtime-selectable model transport configuration.
 *
 * Exports:
 * - `AgentModelTransport`: strict protocol-level transport union.
 * - `ModelProviderConfig`: primary, vision, voice, and transport contract.
 * - `parseModelProviderConfig`: validates decoded server configuration.
 * - `modelProviderConfig`: validated configuration loaded from the canonical runtime path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { AppError } from "./app-error.js";

const MODEL_PROVIDER_CONFIG_PATH = resolve(process.cwd(), "config/agent-model-providers.json");
const modelIdSchema = z.string().trim().min(1).max(200);
const externalBaseUrlSchema = z.url().superRefine((value, context) => {
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
  baseUrl: externalBaseUrlSchema,
  compatibility: z.literal("minimax-anthropic").optional(),
  protocol: z.literal("anthropic-messages"),
  thinking: z.object({ type: z.literal("adaptive") }).strict(),
}).strict();
const openAiChatCompletionsTransportSchema = z.object({
  baseUrl: externalBaseUrlSchema,
  protocol: z.literal("openai-chat-completions"),
  providerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  thinking: z.discriminatedUnion("type", [
    z.object({ effort: z.enum(["low", "high", "max"]), type: z.literal("enabled") }).strict(),
    z.object({ type: z.literal("disabled") }).strict(),
  ]).optional(),
}).strict().superRefine((transport, context) => {
  if (transport.providerName === "deepseek" && transport.thinking === undefined) {
    context.addIssue({ code: "custom", message: "DeepSeek thinking mode must be explicit" });
  }
});
const visionModelSchema = z.discriminatedUnion("supportsImageInput", [
  z.object({ supportsImageInput: z.literal(false) }).strict(),
  z.object({
    id: modelIdSchema,
    maxOutputTokens: z.number().int().positive(),
    supportsImageInput: z.literal(true),
  }).strict(),
]);
const modelProviderConfigSchema = z.object({
  agent: z.object({
    models: z.object({
      primary: z.object({
        contextWindowTokens: z.number().int().positive(),
        id: modelIdSchema,
        maxOutputTokens: z.number().int().positive(),
      }).strict(),
      vision: visionModelSchema,
    }).strict(),
    transport: z.discriminatedUnion("protocol", [
      anthropicMessagesTransportSchema,
      openAiChatCompletionsTransportSchema,
    ]),
  }).strict(),
  schemaVersion: z.literal(3),
  voice: z.object({ transcriptionModelId: modelIdSchema }).strict(),
}).strict();

export type AgentModelTransport = z.infer<typeof modelProviderConfigSchema>["agent"]["transport"];
export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

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

function loadModelProviderConfig(): ModelProviderConfig {
  try {
    const source = readFileSync(MODEL_PROVIDER_CONFIG_PATH, "utf8");
    return parseModelProviderConfig(JSON.parse(source));
  } catch (error) {
    // Keep the original filesystem/parser error while making startup diagnostics searchable.
    if (error instanceof Error && !error.message.includes("AGENT_MODEL_PROVIDER_CONFIG_INVALID")) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_MODEL_PROVIDER_CONFIG_INVALID: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }
}

export const modelProviderConfig = loadModelProviderConfig();
