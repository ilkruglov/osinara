/**
 * The production image client against the environment.
 *
 * Constructs covered:
 * - Without `FAL_KEY` a call fails as not configured before any request.
 * - With it and the chosen model, a generation and an edit go to that model's endpoints at fal.ai
 *   with the trimmed key.
 */
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FAL_IMAGE_MODELS } from "./fal-image-models.js";
import { falQueue } from "./fal-queue.test-fixtures.js";
import { imageGenerationClient } from "./image-generation-client.js";

const request = {
  background: "auto" as const,
  prompt: "кот",
  quality: "auto" as const,
  size: "auto" as const,
};

const GPT = FAL_IMAGE_MODELS["gpt-image-2.6-flare"];

describe("imageGenerationClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is not configured without FAL_KEY and asks nothing of anyone", async () => {
    vi.stubEnv("FAL_KEY", "");
    const queue = falQueue();
    vi.stubGlobal("fetch", queue.fetch);
    expect(() => imageGenerationClient.assertConfigured()).toThrow(
      expect.objectContaining({ code: "AGENT_IMAGE_GENERATION_CONFIG_INVALID" }),
    );
    await expect(imageGenerationClient.generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
    });
    expect(queue.calls).toEqual([]);
  });

  it("generates and edits at fal.ai with FAL_KEY", async () => {
    for (const method of ["info", "log"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
    vi.stubEnv("FAL_KEY", " key-id:key-secret ");
    vi.stubEnv("FAL_IMAGE_MODEL", "gpt-image-2.6-flare");
    const queue = falQueue();
    vi.stubGlobal("fetch", queue.fetch);
    await imageGenerationClient.generate(request);
    const source = await sharp({
      create: { background: "red", channels: 3, height: 64, width: 64 },
    })
      .png()
      .toBuffer();
    await imageGenerationClient.generate({
      ...request,
      referenceImages: [{ bytes: source, mediaType: "image/png" }],
    });
    expect(queue.posts().map((call) => [call.url, call.headers.get("authorization")])).toEqual([
      [`https://queue.fal.run/${GPT.textToImage}`, "Key key-id:key-secret"],
      [`https://queue.fal.run/${GPT.edit}`, "Key key-id:key-secret"],
    ]);
  });
});
