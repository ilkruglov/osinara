/**
 * Explicit AI SDK model registry.
 *
 * Exports:
 * - `primaryModel`: configured protocol-native text model for the Eve agent loop.
 * - `memoryStructuredModel`: non-thinking model route for forced schema-bearing memory tools.
 * - `visionModel`: independently selected model, or `null` when image input is unsupported.
 * - `voiceTranscriptionModel`: isolated Groq Whisper route for Telegram voice notes.
 */
import { createGroq } from "@ai-sdk/groq";

import { modelProviderConfig } from "./model-provider-config.js";
import { createConfiguredLanguageModel } from "./model-transport.js";

const agentModelApiKey = process.env.MODEL_UPSTREAM_API_KEY as string;
const groq = createGroq({ apiKey: process.env.GROQ_API_KEY as string });

export const primaryModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.primary.maxOutputTokens,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: modelProviderConfig.agent.transport,
});
const memoryStructuredTransport = modelProviderConfig.agent.transport.protocol === "openai-chat-completions"
  ? { ...modelProviderConfig.agent.transport, thinking: { type: "disabled" } as const }
  : modelProviderConfig.agent.transport;
export const memoryStructuredModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.primary.maxOutputTokens,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: memoryStructuredTransport,
});
const visionConfig = modelProviderConfig.agent.models.vision;
export const visionModel = visionConfig.supportsImageInput
  ? createConfiguredLanguageModel({
      apiKey: agentModelApiKey,
      maxOutputTokens: visionConfig.maxOutputTokens,
      modelId: visionConfig.id,
      transport: modelProviderConfig.agent.transport,
    })
  : null;

// Voice remains isolated on Groq and never falls back to the agent transport.
export const voiceTranscriptionModel = groq.transcription(
  modelProviderConfig.voice.transcriptionModelId,
);
