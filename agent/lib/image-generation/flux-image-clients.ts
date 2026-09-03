/**
 * Flux image generation providers with an ordered fallback chain.
 *
 * Exports:
 * - `createCloudflareImageClient`: Workers AI text-to-image (klein-4b, schnell for low quality or fallback).
 * - `createNeuralDeepImageClient`: async task API (create → poll → download PNG).
 * - `createFallbackImageClient`: tries providers in order; quota, auth and transport failures of an
 *   earlier provider move on to the next one, a definitive rejection of the prompt does not.
 * - `detectImageMediaType`: PNG / JPEG / WebP by magic bytes; anything else is rejected.
 */
import { AppError, isAppError } from "../app-error.js";
import type { GeneratedImage, ImageGenerationRequest, ImageMediaType } from "./image-generation-client.js";

// klein-9b and flux-2-dev are deliberately absent: they burn the free Workers AI quota in a few images.
export const CLOUDFLARE_IMAGE_MODELS = [
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-1-schnell",
] as const;
type CloudflareImageModel = (typeof CLOUDFLARE_IMAGE_MODELS)[number];

/** Requested quality picks the first model; each failure moves down to a cheaper one. */
export function cloudflareModelsForQuality(quality: ImageGenerationRequest["quality"]): readonly CloudflareImageModel[] {
  if (quality === "low") return ["@cf/black-forest-labs/flux-1-schnell"];
  return CLOUDFLARE_IMAGE_MODELS;
}

/** FLUX.2 models accept only multipart bodies; FLUX.1 schnell accepts JSON. */
function cloudflareRequestBody(model: CloudflareImageModel, fields: Record<string, string>): { body: BodyInit; contentType?: string } {
  if (model === "@cf/black-forest-labs/flux-1-schnell") {
    return { body: JSON.stringify({ height: Number(fields.height), prompt: fields.prompt, steps: Number(fields.steps), width: Number(fields.width) }), contentType: "application/json" };
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return { body: form };
}
export const NEURALDEEP_IMAGE_BASE_URL = "https://api.neuraldeep.ru/v1";
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const GENERATION_TIMEOUT_MS = 3 * 60 * 1_000;
const NEURALDEEP_POLL_INTERVAL_MS = 3_000;
const NEURALDEEP_POLL_TIMEOUT_MS = 4 * 60 * 1_000;
const MAX_IMAGE_BYTES = 32 * 1_024 * 1_024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface FluxImageClient {
  assertConfigured(): void;
  generate(input: ImageGenerationRequest): Promise<GeneratedImage>;
  readonly name: string;
}

interface FetchDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/**
 * Codex sizes map to small Flux dimensions: Workers AI bills per 512x512 tile, so a square is one
 * tile and the landscape/portrait variants are two. NeuralDeep only takes an aspect ratio.
 */
function dimensions(size: ImageGenerationRequest["size"]): { aspectRatio: string; height: number; width: number } {
  switch (size) {
    case "1536x1024": return { aspectRatio: "3:2", height: 512, width: 768 };
    case "1024x1536": return { aspectRatio: "3:5", height: 768, width: 512 };
    default: return { aspectRatio: "1:1", height: 512, width: 512 };
  }
}

function unavailable(provider: string, detail: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE", detail, provider }));
  return new AppError(
    "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE",
    "Сервис генерации изображений сейчас недоступен",
  );
}

function rejected(provider: string, detail: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_REJECTED", detail, provider }));
  return new AppError(
    "AGENT_IMAGE_GENERATION_REJECTED",
    "Сервис генерации изображений отклонил запрос. Измените описание и попробуйте снова",
  );
}

function imageFromBytes(bytes: Buffer, model: string, provider: string): GeneratedImage {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw unavailable(provider, `image size ${bytes.length}`);
  const mediaType = detectImageMediaType(bytes);
  if (mediaType === null) throw unavailable(provider, "unknown image format");
  return { bytes, mediaType, model };
}

/** Statuses after which trying another provider is safe: nothing was produced for this request. */
function isProviderUnavailableStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

export function createCloudflareImageClient(
  options: { accountId: string; token: string } & FetchDependencies,
): FluxImageClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    name: "cloudflare",
    assertConfigured() {
      if (!/^[0-9a-f]{32}$/u.test(options.accountId) || !options.token || /\s/u.test(options.token)) {
        throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Не настроен доступ к Cloudflare Workers AI");
      }
    },
    async generate(input) {
      this.assertConfigured();
      const { height, width } = dimensions(input.size);
      let lastError: AppError | null = null;
      for (const model of cloudflareModelsForQuality(input.quality)) {
        const url = `${CLOUDFLARE_API_BASE_URL}/accounts/${options.accountId}/ai/run/${model}`;
        const { body, contentType: requestContentType } = cloudflareRequestBody(model, {
          height: String(height), prompt: input.prompt, steps: "4", width: String(width),
        });
        let response: Response;
        try {
          response = await fetchImplementation(url, {
            body,
            headers: {
              authorization: `Bearer ${options.token}`,
              ...(requestContentType === undefined ? {} : { "content-type": requestContentType }),
            },
            method: "POST",
            signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
          });
        } catch (error) {
          lastError = unavailable("cloudflare", error instanceof Error ? error.message : String(error));
          continue;
        }
        if (!response.ok) {
          const detail = `${model} ${response.status}`;
          if (isProviderUnavailableStatus(response.status)) { lastError = unavailable("cloudflare", detail); continue; }
          // 400 from the first model may be a model-specific parameter issue; try the simpler model.
          lastError = rejected("cloudflare", detail);
          continue;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const payload = await response.json() as { result?: { image?: unknown }; success?: unknown };
          const encoded = payload.result?.image;
          if (typeof encoded !== "string" || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
            lastError = unavailable("cloudflare", `${model} malformed image payload`);
            continue;
          }
          return imageFromBytes(Buffer.from(encoded, "base64"), model, "cloudflare");
        }
        return imageFromBytes(Buffer.from(await response.arrayBuffer()), model, "cloudflare");
      }
      throw lastError ?? unavailable("cloudflare", "no model available");
    },
  };
}

export function createNeuralDeepImageClient(
  options: { apiKey: string; baseUrl?: string } & FetchDependencies,
): FluxImageClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const baseUrl = (options.baseUrl ?? NEURALDEEP_IMAGE_BASE_URL).replace(/\/$/u, "");
  const headers = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" };
  return {
    name: "neuraldeep",
    assertConfigured() {
      if (!options.apiKey || /\s/u.test(options.apiKey)) {
        throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Не настроен доступ к NeuralDeep Image API");
      }
    },
    async generate(input) {
      this.assertConfigured();
      const { aspectRatio } = dimensions(input.size);
      let created: Response;
      try {
        created = await fetchImplementation(`${baseUrl}/images/generate`, {
          body: JSON.stringify({ options: { aspect_ratio: aspectRatio }, prompt: input.prompt }),
          headers,
          method: "POST",
          signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        });
      } catch (error) {
        throw unavailable("neuraldeep", error instanceof Error ? error.message : String(error));
      }
      if (!created.ok) {
        throw isProviderUnavailableStatus(created.status)
          ? unavailable("neuraldeep", `create ${created.status}`)
          : rejected("neuraldeep", `create ${created.status}`);
      }
      const task = await created.json() as { task_uid?: unknown };
      if (typeof task.task_uid !== "string" || !/^[0-9a-f-]{8,64}$/u.test(task.task_uid)) {
        throw unavailable("neuraldeep", "task id missing");
      }
      const deadline = Date.now() + NEURALDEEP_POLL_TIMEOUT_MS;
      for (;;) {
        await sleep(NEURALDEEP_POLL_INTERVAL_MS);
        const status = await fetchImplementation(`${baseUrl}/images/tasks/${task.task_uid}`, { headers, method: "GET" });
        if (!status.ok) throw unavailable("neuraldeep", `status ${status.status}`);
        const state = (await status.json() as { error?: unknown; status?: unknown }).status;
        if (state === "finished") break;
        if (state === "failed" || state === "error") throw rejected("neuraldeep", "task failed");
        if (Date.now() > deadline) throw unavailable("neuraldeep", "poll timeout");
      }
      const result = await fetchImplementation(`${baseUrl}/images/tasks/${task.task_uid}/result`, { headers, method: "GET" });
      if (!result.ok) throw unavailable("neuraldeep", `result ${result.status}`);
      return imageFromBytes(Buffer.from(await result.arrayBuffer()), "neuraldeep/flux", "neuraldeep");
    },
  };
}

export function createFallbackImageClient(clients: readonly FluxImageClient[]): FluxImageClient {
  if (clients.length === 0) {
    throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Не настроен ни один сервис генерации изображений");
  }
  return {
    name: clients.map((client) => client.name).join(">"),
    assertConfigured() {
      for (const client of clients) client.assertConfigured();
    },
    async generate(input) {
      let lastError: unknown = null;
      for (const client of clients) {
        try {
          return await client.generate(input);
        } catch (error) {
          lastError = error;
          // A prompt the provider refused would be refused again; only availability moves on.
          if (isAppError(error) && error.code === "AGENT_IMAGE_GENERATION_REJECTED") throw error;
          console.error(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_FALLBACK", from: client.name }));
        }
      }
      throw lastError instanceof Error ? lastError : unavailable("chain", "all providers failed");
    },
  };
}
