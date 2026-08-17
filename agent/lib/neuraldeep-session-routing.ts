/**
 * NeuralDeep session-sticky model routing.
 *
 * Exports:
 * - `resolveSessionModelSelection`: binds NeuralDeep requests to one upstream by Eve session ID.
 */
import type { AgentModelOptionsDefinition } from "eve";
import type { LanguageModel } from "ai";

import type { ModelProviderId } from "./model-provider-config.js";

interface SessionModelSelectionInput {
  readonly model: LanguageModel;
  readonly providerId: ModelProviderId;
  readonly sessionId: string;
}

interface SessionModelSelection {
  readonly model: LanguageModel;
  readonly modelOptions: AgentModelOptionsDefinition;
}

export function resolveSessionModelSelection({
  model,
  providerId,
  sessionId,
}: SessionModelSelectionInput): SessionModelSelection | null {
  // NeuralDeep uses this OpenAI-compatible field for sticky upstream routing and KV-cache reuse.
  if (providerId !== "neuraldeep") return null;

  return {
    model,
    modelOptions: {
      providerOptions: {
        neuraldeep: { user: sessionId },
      },
    },
  };
}
