/**
 * NeuralDeep session-sticky model routing tests.
 *
 * Constructs covered:
 * - `resolveSessionModelSelection`: adds the Eve session identity only to NeuralDeep requests.
 * - Non-NeuralDeep providers retain their static model selection without provider options.
 */
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { resolveSessionModelSelection } from "./neuraldeep-session-routing.js";

const model = { modelId: "test-model", provider: "test-provider" } as LanguageModel;

describe("resolveSessionModelSelection", () => {
  it("uses the opaque Eve session ID for NeuralDeep sticky routing", () => {
    expect(resolveSessionModelSelection({
      model,
      providerId: "neuraldeep",
      sessionId: "session_01CACHE",
    })).toEqual({
      model,
      modelOptions: {
        providerOptions: {
          neuraldeep: { user: "session_01CACHE" },
        },
      },
    });
  });

  it("does not add NeuralDeep provider options to another provider", () => {
    expect(resolveSessionModelSelection({
      model,
      providerId: "deepseek",
      sessionId: "session_01CACHE",
    })).toBeNull();
  });
});
