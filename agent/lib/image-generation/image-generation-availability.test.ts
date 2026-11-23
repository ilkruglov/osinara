/**
 * Image generation availability.
 *
 * Constructs covered:
 * - `supportsImageGeneration`: `FAL_KEY` with the model the owner chose (`FAL_IMAGE_MODEL`) enables
 *   the tool; either alone does not, the old providers' keys do not, an unknown model is an error.
 * - `resolveImageProvider`: the fal.ai client, or none.
 * - `IMAGE_GENERATION_AVAILABLE`: a key that is set but unusable, a key without a model and a model
 *   without a key are named in the log, not silent; an unknown model fails startup without its value.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveImageProvider, supportsImageGeneration } from "./image-generation-availability.js";

describe("image generation availability", () => {
  it("is fal.ai with FAL_KEY and FAL_IMAGE_MODEL and nothing without them", () => {
    for (const model of ["gpt-image-2.6-flare", "seedream-5.5"]) {
      expect(
        resolveImageProvider({ FAL_IMAGE_MODEL: model, FAL_KEY: " key-id:key-secret " }),
      ).not.toBeNull();
      expect(
        supportsImageGeneration({ FAL_IMAGE_MODEL: model, FAL_KEY: "key-id:key-secret" }),
      ).toBe(true);
    }
    // An unusable key is given with a model: without one the tool is off whatever the key holds.
    const model = "gpt-image-2.6-flare";
    for (const environment of [
      {},
      { FAL_KEY: "key-id:key-secret" },
      { FAL_IMAGE_MODEL: model },
      { FAL_IMAGE_MODEL: model, FAL_KEY: "  " },
      { FAL_IMAGE_MODEL: model, FAL_KEY: "key-id:key secret" },
      // Not a byte string: Node refuses it as a header before anything is sent.
      { FAL_IMAGE_MODEL: model, FAL_KEY: "key-id:key-sеcret" },
      { FAL_IMAGE_MODEL: model, FAL_KEY: "key-id:key\u200Bsecret" },
      { NEURALDEEP_IMAGE_API_KEY: "nd", PLUSVIBE_API_KEY: "pv" },
      { CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), CLOUDFLARE_AI_TOKEN: "cf" },
    ]) {
      expect(resolveImageProvider(environment)).toBeNull();
      expect(supportsImageGeneration(environment)).toBe(false);
    }
  });

  it("refuses a model it does not know, by name", () => {
    expect(() =>
      supportsImageGeneration({ FAL_IMAGE_MODEL: "gpt-image-2", FAL_KEY: "key-id:key-secret" }),
    ).toThrow(expect.objectContaining({ code: "AGENT_IMAGE_GENERATION_CONFIG_INVALID" }));
  });

  describe("at startup", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    // Compose leaves an unset key empty: silent. A key that is set but unusable is named, never shown.
    it.each([
      ["key-id:key-sеcret", true],
      ["   ", true],
      ["", false],
    ])("logs FAL_KEY %j as unusable: %s", async (key, logs) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv("FAL_KEY", key);
      vi.stubEnv("FAL_IMAGE_MODEL", "gpt-image-2.6-flare");
      vi.resetModules();
      const fresh = await import("./image-generation-availability.js");
      expect(fresh.IMAGE_GENERATION_AVAILABLE).toBe(false);
      const logged = error.mock.calls.flat().join("\n");
      expect(logged.includes("AGENT_IMAGE_GENERATION_KEY_INVALID")).toBe(logs);
      expect(logged).not.toContain("key-id");
    });

    it("names a key set without a model in the log", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv("FAL_KEY", "key-id:key-secret");
      vi.stubEnv("FAL_IMAGE_MODEL", "");
      vi.resetModules();
      const fresh = await import("./image-generation-availability.js");
      expect(fresh.IMAGE_GENERATION_AVAILABLE).toBe(false);
      expect(error.mock.calls.flat().join("\n")).toContain("AGENT_IMAGE_GENERATION_MODEL_MISSING");
    });

    // Compose leaves an unset variable empty: an empty key is no key, and nothing set is silent.
    it.each([
      [undefined, "gpt-image-2.6-flare", true],
      ["", "seedream-5.5", true],
      ["", "", false],
      [undefined, undefined, false],
    ])("logs FAL_KEY %j with FAL_IMAGE_MODEL %j as missing: %s", async (key, model, logs) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv("FAL_KEY", key);
      vi.stubEnv("FAL_IMAGE_MODEL", model);
      vi.resetModules();
      const fresh = await import("./image-generation-availability.js");
      expect(fresh.IMAGE_GENERATION_AVAILABLE).toBe(false);
      const logged = error.mock.calls.flat().join("\n");
      expect(logged.includes("AGENT_IMAGE_GENERATION_KEY_MISSING")).toBe(logs);
      if (!logs) expect(logged).toBe("");
    });

    // An owner who mixed the two variables up must not find the key in the startup log.
    it("refuses an unknown model by the variable's name, without its value", async () => {
      vi.stubEnv("FAL_KEY", "key-id:key-secret");
      vi.stubEnv("FAL_IMAGE_MODEL", "other-id:other-secret");
      vi.resetModules();
      let failure: unknown;
      try {
        await import("./image-generation-availability.js");
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toMatchObject({ code: "AGENT_IMAGE_GENERATION_CONFIG_INVALID" });
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toContain("FAL_IMAGE_MODEL");
      expect(message).toContain("gpt-image-2.6-flare");
      expect(message).not.toContain("other-id");
    });
  });
});
