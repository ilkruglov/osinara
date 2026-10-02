/**
 * Image generation availability tests.
 *
 * Constructs covered:
 * - `supportsImageGeneration`: any one configured provider enables the tool.
 * - `resolveImageProviders`: PlusVibe → NeuralDeep → Cloudflare; unset keys drop out without gaps.
 */
import { describe, expect, it } from "vitest";

import { resolveImageProviders, supportsImageGeneration } from "./image-generation-availability.js";

const FULL = {
  CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
  CLOUDFLARE_AI_TOKEN: "cf",
  NEURALDEEP_IMAGE_API_KEY: "nd",
  PLUSVIBE_API_KEY: "pv",
};

describe("image generation availability", () => {
  it("keeps the free Cloudflare quota as the last resort", () => {
    expect(resolveImageProviders(FULL).map((client) => client.name)).toEqual(["plusvibe", "neuraldeep", "cloudflare"]);
  });

  it("keeps only configured providers and enables the tool from any one of them", () => {
    expect(resolveImageProviders({ PLUSVIBE_API_KEY: " pv " }).map((client) => client.name)).toEqual(["plusvibe"]);
    expect(resolveImageProviders({ CLOUDFLARE_ACCOUNT_ID: FULL.CLOUDFLARE_ACCOUNT_ID }).map((client) => client.name)).toEqual([]);
    expect(supportsImageGeneration({ PLUSVIBE_API_KEY: "pv" })).toBe(true);
    expect(supportsImageGeneration({})).toBe(false);
  });
});
