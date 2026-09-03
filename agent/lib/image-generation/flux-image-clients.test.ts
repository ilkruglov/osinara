/**
 * Flux provider chain tests.
 *
 * Constructs covered:
 * - Cloudflare klein-4b takes a multipart body; the media type comes from magic bytes, not from the provider.
 * - Any Cloudflare failure (quota, content filter, transport) falls through to NeuralDeep; schnell is
 *   never tried because it neither accepts dimensions nor a cheaper quality.
 * - When every provider rejects the prompt the chain reports a rejection, not an outage.
 * - NeuralDeep creates a task, polls until finished and downloads the PNG result.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFLARE_IMAGE_MODELS,
  createCloudflareImageClient,
  createFallbackImageClient,
  createNeuralDeepImageClient,
  detectImageMediaType,
} from "./flux-image-clients.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const request = { background: "auto" as const, prompt: "кот на подоконнике", quality: "auto" as const, size: "1024x1024" as const };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function neuralDeepSuccess() {
  return vi.fn()
    .mockResolvedValueOnce(json({ task_uid: "1ca2c888-1a64-4fbe-99e9-23c230779a37" }))
    .mockResolvedValueOnce(json({ status: "queued" }))
    .mockResolvedValueOnce(json({ status: "finished" }))
    .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" }, status: 200 }));
}

describe("flux image clients", () => {
  it("detects image formats by magic bytes", () => {
    expect(detectImageMediaType(PNG)).toBe("image/png");
    expect(detectImageMediaType(JPEG)).toBe("image/jpeg");
    expect(detectImageMediaType(Buffer.from("hello"))).toBeNull();
  });

  it("offers only klein-4b on Cloudflare", () => {
    expect(CLOUDFLARE_IMAGE_MODELS).toEqual(["@cf/black-forest-labs/flux-2-klein-4b"]);
  });

  it("generates through Cloudflare klein-4b and derives the media type from bytes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ result: { image: JPEG.toString("base64") }, success: true }));
    const client = createCloudflareImageClient({ accountId: "0".repeat(32), fetch: fetch as never, token: "cf-token" });

    const image = await client.generate({ ...request, quality: "low" });

    expect(image).toMatchObject({ mediaType: "image/jpeg", model: "@cf/black-forest-labs/flux-2-klein-4b" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/ai/run/@cf/black-forest-labs/flux-2-klein-4b");
    // FLUX.2 takes multipart form fields, not JSON.
    expect(init.body).toBeInstanceOf(FormData);
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ height: "512", prompt: "кот на подоконнике", steps: "4", width: "512" });
    expect(init.headers["content-type"]).toBeUndefined();
  });

  it("falls back from an exhausted Cloudflare quota to NeuralDeep", async () => {
    const cloudflareFetch = vi.fn().mockResolvedValue(json({ errors: [{ code: 3040, message: "quota" }] }, 429));
    const neuralFetch = neuralDeepSuccess();
    const chain = createFallbackImageClient([
      createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch as never, token: "cf-token" }),
      createNeuralDeepImageClient({ apiKey: "nd-key", fetch: neuralFetch as never, sleep: async () => {} }),
    ]);

    const image = await chain.generate({ ...request, size: "1536x1024" });

    expect(image).toMatchObject({ mediaType: "image/png", model: "neuraldeep/flux" });
    expect(cloudflareFetch).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries((cloudflareFetch.mock.calls[0]![1].body as FormData).entries())).toMatchObject({ height: "512", width: "768" });
    expect(JSON.parse(neuralFetch.mock.calls[0]![1].body)).toEqual({ options: { aspect_ratio: "3:2" }, prompt: "кот на подоконнике" });
    expect(String(neuralFetch.mock.calls[3]![0])).toContain("/images/tasks/1ca2c888-1a64-4fbe-99e9-23c230779a37/result");
  });

  it("falls back to NeuralDeep when the Cloudflare content filter flags the prompt", async () => {
    const cloudflareFetch = vi.fn().mockResolvedValue(json({ errors: [{ code: 3030, message: "Your output has been flagged" }] }, 400));
    const neuralFetch = neuralDeepSuccess();
    const chain = createFallbackImageClient([
      createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch as never, token: "cf-token" }),
      createNeuralDeepImageClient({ apiKey: "nd-key", fetch: neuralFetch as never, sleep: async () => {} }),
    ]);

    const image = await chain.generate({ ...request, prompt: "Porsche Cayman на дороге" });

    expect(image).toMatchObject({ mediaType: "image/png", model: "neuraldeep/flux" });
    expect(neuralFetch).toHaveBeenCalledTimes(4);
  });

  it("reports a rejection with a wording hint when every provider refuses the prompt", async () => {
    const cloudflareFetch = vi.fn().mockResolvedValue(json({ errors: [{ code: 3030, message: "flagged" }] }, 400));
    const neuralFetch = vi.fn().mockResolvedValue(json({ error: "bad prompt" }, 422));
    const chain = createFallbackImageClient([
      createCloudflareImageClient({ accountId: "0".repeat(32), fetch: cloudflareFetch as never, token: "cf-token" }),
      createNeuralDeepImageClient({ apiKey: "nd-key", fetch: neuralFetch as never }),
    ]);

    await expect(chain.generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
      message: expect.stringContaining("брендов"),
    });
    expect(neuralFetch).toHaveBeenCalledTimes(1);
  });
});
