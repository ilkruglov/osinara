/**
 * LLM provider registry tests.
 *
 * Constructs covered:
 * - `primaryModel`: server-configured protocol-native text route for the Eve agent loop.
 * - `visionModel`: independently configured model on the same transport.
 * - `voiceTranscriptionModel`: explicit Groq Whisper transcription route.
 */
import { describe, expect, it } from "vitest";

import { modelProviderConfig } from "./model-provider-config.js";
import {
  primaryModel,
  visionModel,
  voiceTranscriptionModel,
} from "./model-registry.js";

describe("model registry", () => {
  it("selects the configured protocol-native text model", () => {
    expect(modelProviderConfig.agent.transport.protocol).toBe("anthropic-messages");
    expect(primaryModel.modelId).toBe(modelProviderConfig.agent.models.primary.id);
    expect(primaryModel.provider).toBe("anthropic.messages");
  });

  it("selects the independently configured vision model", () => {
    expect(visionModel.modelId).toBe(modelProviderConfig.agent.models.vision.id);
    expect(visionModel.provider).toBe("anthropic.messages");
  });

  it("selects the explicit Groq Whisper model for voice transcription", () => {
    expect(voiceTranscriptionModel.modelId).toBe(
      modelProviderConfig.voice.transcriptionModelId,
    );
    expect(voiceTranscriptionModel.provider).toBe("groq.transcription");
  });
});
