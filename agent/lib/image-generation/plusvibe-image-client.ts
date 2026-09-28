/**
 * PlusVibe media API client (Nano Banana 2 generation and editing).
 *
 * Exports:
 * - `createPlusVibeImageClient`: `POST /api/media/generate` → job → poll `/api/media/jobs/{id}` →
 *   download `resultUrls[0]`.
 * - `PLUSVIBE_GENERATION_MODEL`, `PLUSVIBE_EDITING_MODEL`: the `:white` route only generates; a
 *   picture on input is accepted by the route without a suffix (verified live on 28 September 2026).
 *
 * Key constructs:
 * - References travel as `input_base64` data URIs (JPEG, longer side ≤ 1536): URL fields take only
 *   public https links, and PlusVibe publishes the uploaded bytes for its provider itself.
 * - `ok: false` on create and `failed` on poll are definitive rejections; anything after an accepted
 *   job with an unknown outcome stays ambiguous, so the chain never bills twice.
 */
import { AppError, isAppError } from "../app-error.js";
import {
  ambiguous,
  GENERATION_TIMEOUT_MS,
  imageFromBytes,
  isAmbiguousStatus,
  isProviderUnavailableStatus,
  readBoundedBody,
  rejected,
  scrubProviderText,
  unavailable,
  type FluxImageClient,
} from "./flux-image-clients.js";
import { assertReferenceCount, prepareUploadReference } from "./image-editing-input.js";
import type { ImageGenerationRequest } from "./image-generation-client.js";

export const PLUSVIBE_API_BASE_URL = "https://plusvibeapi.ru";
export const PLUSVIBE_GENERATION_MODEL = "nano-banana-2:white";
export const PLUSVIBE_EDITING_MODEL = "nano-banana-2";
const PROVIDER = "plusvibe";
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 4 * 60 * 1_000;
const JOB_ID_PATTERN = /^[a-z0-9]{8,64}$/u;

/** Nano Banana 2 offers 1:1, 16:9, 9:16, 4:3 and 3:4 at 1K; the tool's landscape and portrait sizes map to 4:3 and 3:4. */
export function plusVibeAspectRatio(size: ImageGenerationRequest["size"]): "1:1" | "3:4" | "4:3" {
  switch (size) {
    case "1536x1024": return "4:3";
    case "1024x1536": return "3:4";
    case "1024x1024":
    case "auto": return "1:1";
  }
}

interface JobStatus {
  errorCode?: unknown;
  failMsg?: unknown;
  priceRub?: unknown;
  resultUrls?: unknown;
  status?: unknown;
}

export function createPlusVibeImageClient(
  options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    pollTimeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): FluxImageClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const baseUrl = (options.baseUrl ?? PLUSVIBE_API_BASE_URL).replace(/\/$/u, "");
  const pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const headers = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" };

  async function createJob(model: string, prompt: string, opts: Record<string, unknown>): Promise<string> {
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}/api/media/generate`, {
        body: JSON.stringify({ model, opts, prompt }),
        headers,
        method: "POST",
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
    } catch (error) {
      throw ambiguous(PROVIDER, error instanceof Error ? error.message : String(error));
    }
    if (isAmbiguousStatus(response.status)) throw ambiguous(PROVIDER, `create ${response.status}`);
    interface CreatePayload { jobId?: unknown; message?: unknown; ok?: unknown }
    let payload: CreatePayload | null;
    try {
      payload = await response.json() as CreatePayload;
    } catch {
      payload = null;
    }
    const message = scrubProviderText(payload?.message, options.apiKey);
    if (isProviderUnavailableStatus(response.status)) throw unavailable(PROVIDER, `create ${response.status} ${message}`.trim());
    if (!response.ok || payload?.ok === false) throw rejected(PROVIDER, `${model} create ${response.status} ${message}`.trim());
    if (typeof payload?.jobId !== "string" || !JOB_ID_PATTERN.test(payload.jobId)) throw ambiguous(PROVIDER, "job id missing");
    return payload.jobId;
  }

  async function awaitJob(model: string, jobId: string): Promise<Buffer> {
    const deadline = Date.now() + pollTimeoutMs;
    const remaining = () => {
      const left = deadline - Date.now();
      if (left <= 0) throw ambiguous(PROVIDER, "poll timeout");
      return AbortSignal.timeout(left);
    };
    const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      try {
        return await operation(remaining());
      } catch (error) {
        if (isAppError(error)) throw error;
        throw ambiguous(PROVIDER, error instanceof Error ? error.message : String(error));
      }
    };
    let job: JobStatus;
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const response = await bounded((signal) => fetchImplementation(`${baseUrl}/api/media/jobs/${jobId}`, { headers, method: "GET", signal }));
      if (!response.ok) throw ambiguous(PROVIDER, `status ${response.status}`);
      job = await bounded(() => response.json() as Promise<JobStatus>);
      if (job.status === "success") break;
      if (job.status === "failed" || job.status === "error") {
        const detail = scrubProviderText([job.errorCode, job.failMsg].filter((part) => typeof part === "string").join(" "), options.apiKey);
        throw rejected(PROVIDER, `${model} job failed ${detail}`.trim());
      }
      remaining();
    }
    const resultUrl = Array.isArray(job.resultUrls) ? job.resultUrls[0] : undefined;
    if (typeof resultUrl !== "string" || !resultUrl.startsWith("https://")) throw ambiguous(PROVIDER, "result url missing");
    console.log(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_BILLED", model, priceRub: typeof job.priceRub === "number" ? job.priceRub : null, provider: PROVIDER }));
    // The result link is pre-signed; the key stays with the API host only.
    const result = await bounded((signal) => fetchImplementation(resultUrl, { method: "GET", signal }));
    if (!result.ok) throw ambiguous(PROVIDER, `result ${result.status}`);
    return await bounded(() => readBoundedBody(result));
  }

  return {
    name: PROVIDER,
    supportsEditing: true,
    assertConfigured() {
      if (!options.apiKey || /\s/u.test(options.apiKey)) {
        throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Не настроен доступ к PlusVibe API");
      }
    },
    async generate(input) {
      this.assertConfigured();
      const opts: Record<string, unknown> = { aspect_ratio: plusVibeAspectRatio(input.size), resolution: "1K" };
      let model: string = PLUSVIBE_GENERATION_MODEL;
      if (input.referenceImages?.length) {
        assertReferenceCount(input.referenceImages);
        const references: string[] = [];
        for (const reference of input.referenceImages) {
          references.push(`data:image/jpeg;base64,${(await prepareUploadReference(reference)).toString("base64")}`);
        }
        opts.input_base64 = references;
        model = PLUSVIBE_EDITING_MODEL;
      }
      const jobId = await createJob(model, input.prompt, opts);
      return imageFromBytes(await awaitJob(model, jobId), `${PROVIDER}/${model}`, PROVIDER);
    },
  };
}
