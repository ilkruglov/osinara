/**
 * Explicit AI SDK model registry.
 *
 * Exports:
 * - `primaryModel`: configured protocol-native text model for the Eve agent loop.
 * - `visionModel`: independently selected model on the same agent transport.
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
export const visionModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.vision.maxOutputTokens,
  modelId: modelProviderConfig.agent.models.vision.id,
  transport: modelProviderConfig.agent.transport,
});

// Voice remains isolated on Groq and never falls back to the agent transport.
export const voiceTranscriptionModel = groq.transcription(
  modelProviderConfig.voice.transcriptionModelId,
);
