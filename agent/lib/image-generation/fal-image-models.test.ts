/**
 * The fal models the owner chooses between (`FAL_IMAGE_MODEL`), through the real client.
 *
 * Constructs covered:
 * - GPT Image 2.6 Flare: its own endpoints, always `quality: low` and `reasoning_effort: low`, the
 *   tool's sizes as exact pixels (`auto` stays `auto`), JPEG or PNG for a transparent background,
 *   the picture inline; an edit sends its references to the edit endpoint.
 * - Seedream 5.5 keeps its 1.5K sizes and tariff.
 * - Each model draws at its text-to-image endpoint and edits at its edit endpoint, as fal names
 *   them (literals, not the table under test).
 */
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  falClient as client,
  falQueue,
  IMAGE_REQUEST as request,
} from "./fal-queue.test-fixtures.js";
import type { FalImageModelId } from "./fal-image-models.js";

const ENDPOINTS: ReadonlyArray<[FalImageModelId, string, string]> = [
  [
    "gpt-image-2.6-flare",
    "openai/gpt-image-2.6/flare/text-to-image",
    "openai/gpt-image-2.6/flare/edit",
  ],
  ["seedream-5.5", "bytedance/seedream/v5.5/text-to-image", "bytedance/seedream/v5.5/edit"],
];

async function redSquare(): Promise<Buffer> {
  return await sharp({ create: { background: "red", channels: 3, height: 64, width: 64 } })
    .png()
    .toBuffer();
}

describe("fal image models", () => {
  beforeEach(() => {
    for (const method of ["error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("draws with GPT Image 2.6 Flare at low quality and low reasoning, the size exact", async () => {
    const queue = falQueue();
    await client(queue, { model: "gpt-image-2.6-flare" }).generate({
      ...request,
      quality: "high",
      size: "1536x1024",
    });
    await client(queue, { model: "gpt-image-2.6-flare" }).generate({
      ...request,
      background: "transparent",
      size: "auto",
    });
    const [landscape, transparent] = queue.posts();
    expect(landscape!.url).toBe("https://queue.fal.run/openai/gpt-image-2.6/flare/text-to-image");
    // The owner set low quality for speed: what the model asks for does not change it.
    expect(landscape!.body).toEqual({
      background: "auto",
      image_size: { height: 1_024, width: 1_536 },
      num_images: 1,
      output_format: "jpeg",
      prompt: request.prompt,
      quality: "low",
      reasoning_effort: "low",
      sync_mode: true,
    });
    expect(transparent!.body).toMatchObject({
      background: "transparent",
      image_size: "auto",
      output_format: "png",
    });
  });

  it("edits with GPT Image 2.6 Flare at its edit endpoint", async () => {
    const queue = falQueue();
    await client(queue, { model: "gpt-image-2.6-flare" }).generate({
      ...request,
      referenceImages: [{ bytes: await redSquare(), mediaType: "image/png" }],
      size: "auto",
    });
    const [edit] = queue.posts();
    expect(edit!.url).toBe("https://queue.fal.run/openai/gpt-image-2.6/flare/edit");
    expect(edit!.body).toMatchObject({
      image_size: "auto",
      image_urls: [expect.stringMatching(/^data:image\/jpeg;base64,/u)],
      quality: "low",
      reasoning_effort: "low",
      sync_mode: true,
    });
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "openai/gpt-image-2.6/flare/edit",
    );
  });

  it("keeps Seedream 5.5 at its 1.5K sizes", async () => {
    const queue = falQueue();
    await client(queue, { model: "seedream-5.5" }).generate({ ...request, size: "1536x1024" });
    const [submit] = queue.posts();
    expect(submit!.url).toBe("https://queue.fal.run/bytedance/seedream/v5.5/text-to-image");
    expect(submit!.body).toMatchObject({ image_size: { height: 1_296, width: 1_944 } });
    expect(submit!.body).not.toHaveProperty("quality");
  });

  it.each(ENDPOINTS)("draws with %s at %s and edits at %s", async (model, textToImage, edit) => {
    const queue = falQueue();
    await client(queue, { model }).generate(request);
    await client(queue, { model }).generate({
      ...request,
      referenceImages: [{ bytes: await redSquare(), mediaType: "image/png" }],
    });
    expect(queue.posts().map((post) => post.url)).toEqual([
      `https://queue.fal.run/${textToImage}`,
      `https://queue.fal.run/${edit}`,
    ]);
  });
});
