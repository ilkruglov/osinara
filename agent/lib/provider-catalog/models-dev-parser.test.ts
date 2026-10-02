/**
 * Models.dev metadata parser tests.
 *
 * Constructs covered:
 * - Empty reasoning metadata never implies a reasoning mode.
 * - Budget-token reasoning and efforts outside the transport's union are excluded.
 * - An OpenAI-protocol toggle maps only to disabled reasoning.
 * - Unknown metadata option contracts fail fast instead of being silently ignored.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "../app-error.js";
import { enrichModelsFromModelsDev } from "./models-dev-parser.js";

/** Creates one complete metadata model while allowing targeted reasoning overrides. */
function metadataCatalog(reasoningOptions: unknown[]): unknown {
  return {
    deepseek: {
      id: "deepseek",
      models: {
        "deepseek-v4-flash": {
          id: "deepseek-v4-flash",
          limit: { context: 1_000_000, output: 65_536 },
          modalities: { input: ["text"], output: ["text"] },
          name: "DeepSeek V4 Flash",
          reasoning_options: reasoningOptions,
          tool_call: true,
        },
      },
      name: "DeepSeek",
    },
  };
}

describe("enrichModelsFromModelsDev", () => {
  it.each([
    [[]],
    [[{ max: 262_144, type: "budget_tokens" }]],
    [[{ type: "effort", values: ["medium", "xhigh", "minimal"] }]],
  ])("does not invent an unsupported reasoning selection for %#", (reasoningOptions) => {
    const [model] = enrichModelsFromModelsDev(
      metadataCatalog(reasoningOptions),
      "deepseek",
      [{ id: "deepseek-v4-flash", protocol: "openai-chat-completions" }],
    );

    expect(model.reasoningOptions).toEqual([]);
  });

  it("keeps none for an OpenAI toggle when no provider-native enabled mode is expressible", () => {
    const [model] = enrichModelsFromModelsDev(
      metadataCatalog([{ type: "toggle" }]),
      "deepseek",
      [{ id: "deepseek-v4-flash", protocol: "openai-chat-completions" }],
    );

    expect(model.reasoningOptions).toEqual([{ type: "none" }]);
  });

  it("rejects an unknown reasoning option contract", () => {
    expect(() => enrichModelsFromModelsDev(
      metadataCatalog([{ type: "future-mode", value: true }]),
      "deepseek",
      [{ id: "deepseek-v4-flash", protocol: "openai-chat-completions" }],
    )).toThrow(expect.objectContaining<Partial<AppError>>({
      code: "AGENT_PROVIDER_METADATA_RESPONSE_INVALID",
    }));
  });
});
