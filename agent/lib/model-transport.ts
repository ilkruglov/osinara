/**
 * Protocol-native AI SDK model factory.
 *
 * Exports:
 * - `ConfiguredLanguageModelOptions`: explicit model, secret, transport, and test fetch inputs.
 * - `createConfiguredLanguageModel`: creates a standard AI SDK model by wire protocol.
 *
 * Key constructs:
 * - Anthropic Messages adaptive thinking is enforced at the transport boundary.
 * - Explicit MiniMax compatibility preserves provider web-search payloads across Anthropic parsing.
 * - OpenAI Chat Completions remains a generic provider-independent transport.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";

import type { AgentModelTransport } from "./model-provider-config.js";
import { AppError } from "./app-error.js";
import { createMiniMaxAnthropicCompatibilityFetch } from "./minimax-anthropic-compatibility.js";

export interface ConfiguredLanguageModelOptions {
  readonly apiKey: string;
  readonly fetch?: FetchFunction;
  readonly maxOutputTokens: number;
  readonly modelId: string;
  readonly transport: AgentModelTransport;
}

function createCredentialGuardedFetch(options: ConfiguredLanguageModelOptions): FetchFunction {
  return async (input, init) => {
    if (!options.apiKey || /\s/u.test(options.apiKey)) {
      throw new AppError(
        "AGENT_MODEL_API_KEY_INVALID",
        "Не задан корректный ключ доступа к основной модели",
      );
    }
    return (options.fetch ?? globalThis.fetch)(input, init);
  };
}

function createTransportDefaultsMiddleware(
  maxOutputTokens: number,
  adaptiveThinking: boolean,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async transformParams({ params }) {
      return {
        ...params,
        maxOutputTokens: params.maxOutputTokens ?? maxOutputTokens,
        providerOptions: {
          ...params.providerOptions,
          ...(adaptiveThinking
            ? {
                anthropic: {
                  ...params.providerOptions?.anthropic,
                  thinking: { type: "adaptive" },
                },
              }
            : {}),
        },
      };
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      assertCompleteFinishReason(result.finishReason);
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === "finish") assertCompleteFinishReason(part.finishReason);
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

function assertCompleteFinishReason(finishReason: LanguageModelV4FinishReason): void {
  if (finishReason.unified === "stop" || finishReason.unified === "tool-calls") return;
  if (finishReason.unified === "length") {
    throw new AppError(
      "AGENT_MODEL_OUTPUT_TRUNCATED",
      "Модель оборвала ответ из-за ограничения длины. Сократите запрос или попросите ответить частями",
    );
  }
  if (finishReason.unified === "content-filter") {
    throw new AppError(
      "AGENT_MODEL_OUTPUT_FILTERED",
      "Модель остановила ответ из-за ограничений безопасности. Переформулируйте запрос",
    );
  }
  throw new AppError(
    "AGENT_MODEL_OUTPUT_INCOMPLETE",
    "Модель не завершила ответ. Попробуйте повторить запрос или сформулировать его иначе",
  );
}

export function createConfiguredLanguageModel(options: ConfiguredLanguageModelOptions) {
  const { transport } = options;
  const guardedFetch = createCredentialGuardedFetch(options);
  if (transport.protocol === "anthropic-messages") {
    const fetch = transport.compatibility === "minimax-anthropic"
      ? createMiniMaxAnthropicCompatibilityFetch(guardedFetch)
      : guardedFetch;
    const provider = createAnthropic({
      baseURL: transport.baseUrl,
      ...(transport.authentication === "bearer"
        ? { authToken: options.apiKey }
        : { apiKey: options.apiKey }),
      fetch,
    });
    return wrapLanguageModel({
      middleware: createTransportDefaultsMiddleware(options.maxOutputTokens, true),
      model: provider(options.modelId),
    });
  }

  const provider = createOpenAICompatible({
    apiKey: options.apiKey,
    baseURL: transport.baseUrl,
    fetch: guardedFetch,
    name: transport.providerName,
  });
  return wrapLanguageModel({
    middleware: createTransportDefaultsMiddleware(options.maxOutputTokens, false),
    model: provider.chatModel(options.modelId),
  });
}
