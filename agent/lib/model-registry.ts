/**
 * Explicit AI SDK model registry.
 *
 * Exports:
 * - `primaryModel`: configured protocol-native text model for the Eve agent loop.
 * - `visionModel`: independently selected model, or `null` when image input is unsupported.
 * - `browserWorkerModel`: the primary model at low reasoning effort for the browser worker, whose
 *   steps are one action each and whose latency is what a person waits through.
 * - `memoryReviewModel`: the primary model at the configured silent-review effort, or the primary
 *   model itself when none is configured.
 * - `voiceTranscriptionModel`: isolated Groq Whisper route for Telegram voice notes.
 */
import { createGroq } from "@ai-sdk/groq";

import { modelProviderConfig } from "./model-provider-config.js";
import type { ModelProviderConfig } from "./model-provider-config-schema.js";
import { createConfiguredLanguageModel } from "./model-transport.js";

const agentModelApiKey = process.env.MODEL_API_KEY as string;
const groqApiKey = process.env.GROQ_API_KEY;

export const primaryModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.primary.maxOutputTokens,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: modelProviderConfig.agent.transport,
});
const visionConfig = modelProviderConfig.agent.models.vision;

/** The shared transport with the vision model's own reasoning effort where the protocol has one. */
export function visionTransport(
  transport: ModelProviderConfig["agent"]["transport"],
  vision: ModelProviderConfig["agent"]["models"]["vision"],
): ModelProviderConfig["agent"]["transport"] {
  if (!vision.supportsImageInput || vision.reasoningEffort === undefined) return transport;
  if (transport.protocol !== "deepseek-responses") return transport;
  return { ...transport, reasoning: { effort: vision.reasoningEffort } };
}

export const visionModel = visionConfig.supportsImageInput
  ? createConfiguredLanguageModel({
      apiKey: agentModelApiKey,
      maxOutputTokens: visionConfig.maxOutputTokens,
      modelId: visionConfig.id,
      transport: visionTransport(modelProviderConfig.agent.transport, visionConfig),
    })
  : null;

// Voice is an explicit optional capability and never falls back to the agent transport.
export const voiceTranscriptionModel = modelProviderConfig.voice.enabled && groqApiKey
  ? createGroq({ apiKey: groqApiKey }).transcription(
      modelProviderConfig.voice.transcriptionModelId,
    )
  : null;

type ReasoningEffort = "none" | "low" | "high" | "max";

/** The primary transport at another reasoning effort where the protocol has such a control. */
function withReasoningEffort(
  transport: ModelProviderConfig["agent"]["transport"],
  effort: ReasoningEffort,
): ModelProviderConfig["agent"]["transport"] {
  if (transport.protocol === "deepseek-responses") return { ...transport, reasoning: { effort } };
  if (transport.protocol === "openai-chat-completions" && transport.reasoning !== null) {
    return {
      ...transport,
      reasoning: effort === "none"
        ? { format: "deepseek", type: "none" }
        : { effort, format: "deepseek", type: "effort" },
    };
  }
  return transport;
}

export const browserWorkerModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.primary.maxOutputTokens,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: withReasoningEffort(modelProviderConfig.agent.transport, "low"),
});

/** The shared transport with the configured silent-review effort, or the transport as is. */
export function memoryReviewTransport(
  transport: ModelProviderConfig["agent"]["transport"],
  primary: ModelProviderConfig["agent"]["models"]["primary"],
): ModelProviderConfig["agent"]["transport"] {
  if (primary.memoryReviewReasoningEffort === undefined) return transport;
  return withReasoningEffort(transport, primary.memoryReviewReasoningEffort);
}

const primaryConfig = modelProviderConfig.agent.models.primary;
export const memoryReviewModel = primaryConfig.memoryReviewReasoningEffort === undefined
  ? primaryModel
  : createConfiguredLanguageModel({
      apiKey: agentModelApiKey,
      maxOutputTokens: primaryConfig.maxOutputTokens,
      modelId: primaryConfig.id,
      transport: memoryReviewTransport(modelProviderConfig.agent.transport, primaryConfig),
    });
