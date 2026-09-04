/**
 * Explicit AI SDK model registry.
 *
 * Exports:
 * - `primaryModel`: configured protocol-native text model for the Eve agent loop.
 * - `visionModel`: independently selected model, or `null` when image input is unsupported.
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
