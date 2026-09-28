/**
 * PlusVibe media client tests.
 *
 * Constructs covered:
 * - Generation goes to `nano-banana-2:white` with the tool size as an aspect ratio, polls the job and
 *   downloads the first result link without the API key.
 * - Editing switches to the route without a suffix and carries references as `input_base64` data URIs.
 * - `ok: false` on create and a failed job are rejections the chain may move past; an accepted job
 *   with an unknown outcome stays ambiguous; quota and auth statuses are outages.
 */
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { createFallbackImageClient } from "./flux-image-clients.js";
import { createPlusVibeImageClient, plusVibeAspectRatio } from "./plusvibe-image-client.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const request = { background: "auto" as const, prompt: "кот на подоконнике", quality: "auto" as const, size: "1024x1024" as const };
const RESULT_URL = "https://plusvibeapi.ru/api/media/file/cmuki4nb207hgzx01jxj5y66a/0?sig=37e258d9";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function success() {
  return vi.fn()
    .mockResolvedValueOnce(json({ jobId: "cmuki4nb207hgzx01jxj5y66a", ok: true, status: "processing" }, 202))
    .mockResolvedValueOnce(json({ status: "processing" }))
    .mockResolvedValueOnce(json({ priceRub: 1.89, resultUrls: [RESULT_URL], status: "success" }))
    .mockResolvedValueOnce(new Response(JPEG, { headers: { "content-type": "image/jpeg" }, status: 200 }));
}

function client(fetch: ReturnType<typeof vi.fn>, apiKey = "pv-key") {
  return createPlusVibeImageClient({ apiKey, fetch: fetch as never, sleep: async () => {} });
}

describe("plusvibe image client", () => {
  it("maps tool sizes to Nano Banana aspect ratios", () => {
    expect(plusVibeAspectRatio("1536x1024")).toBe("4:3");
    expect(plusVibeAspectRatio("1024x1536")).toBe("3:4");
    expect(plusVibeAspectRatio("1024x1024")).toBe("1:1");
    expect(plusVibeAspectRatio("auto")).toBe("1:1");
  });

  it("generates through the white route, polls the job and downloads the signed result", async () => {
    const fetch = success();
    const image = await client(fetch).generate({ ...request, size: "1536x1024" });
    expect(image).toMatchObject({ mediaType: "image/jpeg", model: "plusvibe/nano-banana-2:white" });
    expect(fetch).toHaveBeenCalledTimes(4);
    const [createUrl, createInit] = fetch.mock.calls[0]!;
    expect(String(createUrl)).toBe("https://plusvibeapi.ru/api/media/generate");
    expect(JSON.parse(createInit.body)).toEqual({
      model: "nano-banana-2:white",
      opts: { aspect_ratio: "4:3", resolution: "1K" },
      prompt: "кот на подоконнике",
    });
    expect(createInit.headers.authorization).toBe("Bearer pv-key");
    expect(String(fetch.mock.calls[1]![0])).toBe("https://plusvibeapi.ru/api/media/jobs/cmuki4nb207hgzx01jxj5y66a");
    const [resultUrl, resultInit] = fetch.mock.calls[3]!;
    expect(String(resultUrl)).toBe(RESULT_URL);
    expect(resultInit.headers).toBeUndefined();
  });

  it("edits through the route without a suffix with references as data URIs", async () => {
    const fetch = success();
    const bytes = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "red" } }).png().toBuffer();
    const image = await client(fetch).generate({ ...request, prompt: "добавь тюльпаны", referenceImages: [{ bytes, mediaType: "image/png" }] });
    expect(image).toMatchObject({ mediaType: "image/jpeg", model: "plusvibe/nano-banana-2" });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.model).toBe("nano-banana-2");
    expect(body.opts.input_base64).toHaveLength(1);
    expect(body.opts.input_base64[0]).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/u);
    expect(body.opts.image_url).toBeUndefined();
    const uploaded = Buffer.from(body.opts.input_base64[0].split(",")[1], "base64");
    expect(await sharp(uploaded).metadata()).toMatchObject({ width: 1200, height: 600, format: "jpeg" });
  });

  it("bounds the reference upload to 1536 px on the longer side as JPEG", async () => {
    const fetch = success();
    const bytes = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "red" } }).png().toBuffer();
    await client(fetch).generate({ ...request, referenceImages: [{ bytes, mediaType: "image/png" }] });
    const uploaded = Buffer.from(JSON.parse(fetch.mock.calls[0]![1].body).opts.input_base64[0].split(",")[1], "base64");
    expect(await sharp(uploaded).metadata()).toMatchObject({ width: 1536, height: 1024, format: "jpeg" });
    expect(uploaded.byteLength).toBeLessThan(1024 * 1024);
  });

  it("never logs the API key echoed by the provider", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const fetch = vi.fn().mockResolvedValue(json({ message: "Invalid API key: pv-key-1234567890", ok: false }, 401));
      await expect(client(fetch, "pv-key-1234567890").generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE" });
      const failed = vi.fn()
        .mockResolvedValueOnce(json({ jobId: "cmuki4nb207hgzx01jxj5y66a", ok: true }, 202))
        .mockResolvedValueOnce(json({ failMsg: "upstream rejected Bearer pv-key-1234567890", status: "failed" }));
      await expect(client(failed, "pv-key-1234567890").generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_REJECTED" });
    } finally {
      spy.mockRestore();
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("pv-key-1234567890");
  });

  it("rejects malformed references and too many of them before POST", async () => {
    const fetch = success();
    await expect(client(fetch).generate({ ...request, referenceImages: [{ bytes: Buffer.from("nope"), mediaType: "image/png" }] }))
      .rejects.toMatchObject({ code: "AGENT_IMAGE_EDITING_INPUT_INVALID" });
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    await expect(client(fetch).generate({ ...request, referenceImages: Array.from({ length: 5 }, () => ({ bytes, mediaType: "image/png" })) }))
      .rejects.toMatchObject({ code: "AGENT_IMAGE_EDITING_INPUT_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a route refusal on create as a rejection the chain moves past", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ message: "Выбранный маршрут медиа недоступен для указанных параметров.", ok: false }, 400));
    const next = vi.fn().mockResolvedValue({ bytes: JPEG, mediaType: "image/jpeg", model: "next" });
    const chain = createFallbackImageClient([client(fetch), { name: "next", assertConfigured() {}, generate: next }]);
    await expect(chain.generate(request)).resolves.toMatchObject({ model: "next" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("treats a failed job as a rejection and a quota status as an outage", async () => {
    const failed = vi.fn()
      .mockResolvedValueOnce(json({ jobId: "cmuki4nb207hgzx01jxj5y66a", ok: true }, 202))
      .mockResolvedValueOnce(json({ errorCode: "CONTENT_POLICY", failMsg: "blocked", status: "failed" }));
    await expect(client(failed).generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_REJECTED" });
    const quota = vi.fn().mockResolvedValue(json({ message: "insufficient balance", ok: false }, 402));
    await expect(client(quota).generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE" });
  });

  it.each(["network", "server", "job-id", "poll", "result-url", "download"])(
    "keeps an ambiguous %s outcome terminal", async (failure) => {
      const fetch = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/api/media/generate")) {
          if (failure === "network") throw new TypeError("fetch failed after POST");
          if (failure === "server") return json({}, 502);
          if (failure === "job-id") return json({ ok: true }, 202);
          return json({ jobId: "cmuki4nb207hgzx01jxj5y66a", ok: true }, 202);
        }
        if (String(url).includes("/api/media/jobs/")) {
          if (failure === "poll") throw new TypeError("socket hang up");
          if (failure === "result-url") return json({ resultUrls: [], status: "success" });
          return json({ resultUrls: [RESULT_URL], status: "success" });
        }
        throw new TypeError("socket hang up");
      });
      const next = vi.fn();
      const chain = createFallbackImageClient([client(fetch), { name: "next", assertConfigured() {}, generate: next }]);
      await expect(chain.generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
      expect(next).not.toHaveBeenCalled();
    },
  );

  it("bounds polling and download by one deadline", async () => {
    const hanging = vi.fn()
      .mockResolvedValueOnce(json({ jobId: "cmuki4nb207hgzx01jxj5y66a", ok: true }, 202))
      .mockImplementation((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const bounded = createPlusVibeImageClient({ apiKey: "pv-key", fetch: hanging as never, pollTimeoutMs: 80, sleep: async () => {} });
    const started = Date.now();
    await expect(bounded.generate(request)).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a blank or malformed key before any request", () => {
    expect(() => client(success(), " ").assertConfigured()).toThrow(expect.objectContaining({ code: "AGENT_IMAGE_GENERATION_CONFIG_INVALID" }));
  });
});
