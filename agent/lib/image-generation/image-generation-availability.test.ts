/**
 * Image generation availability tests.
 *
 * Constructs covered:
 * - `supportsSubscriptionImageGeneration`: enables the feature only for CLIProxy-backed Codex.
 * - `resolveImageProviders`: PlusVibe leads both chains; editing prefers NeuralDeep over Cloudflare,
 *   generation the other way round; unset keys drop out without gaps.
 */
import { describe, expect, it } from "vitest";

import { resolveImageProviders, supportsImageGeneration, supportsSubscriptionImageGeneration } from "./image-generation-availability.js";

const FULL = {
  CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
  CLOUDFLARE_AI_TOKEN: "cf",
  NEURALDEEP_IMAGE_API_KEY: "nd",
  PLUSVIBE_API_KEY: "pv",
};

describe("subscription image generation availability", () => {
  it("requires the Codex subscription provider", () => {
    expect(supportsSubscriptionImageGeneration("codex-subscription")).toBe(true);
    for (const provider of [
      "deepseek",
      "groq",
      "minimax",
      "neuraldeep",
      "opencode-go",
      "openrouter",
    ] as const) {
      expect(supportsSubscriptionImageGeneration(provider)).toBe(false);
    }
  });

  it("orders generation and editing chains differently", () => {
    expect(resolveImageProviders(FULL).map((client) => client.name)).toEqual(["plusvibe", "cloudflare", "neuraldeep"]);
    expect(resolveImageProviders(FULL, true).map((client) => client.name)).toEqual(["plusvibe", "neuraldeep", "cloudflare"]);
  });

  it("keeps only configured providers and enables the tool from any one of them", () => {
    expect(resolveImageProviders({ PLUSVIBE_API_KEY: " pv " }).map((client) => client.name)).toEqual(["plusvibe"]);
    expect(resolveImageProviders({ CLOUDFLARE_ACCOUNT_ID: FULL.CLOUDFLARE_ACCOUNT_ID }).map((client) => client.name)).toEqual([]);
    expect(supportsImageGeneration("deepseek", { PLUSVIBE_API_KEY: "pv" })).toBe(true);
    expect(supportsImageGeneration("deepseek", {})).toBe(false);
  });
});
