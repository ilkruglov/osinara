/**
 * fal.ai, the only image provider (owner's decision, 22 November 2026), with the model the owner
 * chooses (`fal-image-models.ts`: GPT Image 2.6 Flare or Seedream 5.5).
 *
 * Exports:
 * - `createFalImageClient`: generation and editing (references as JPEG data URIs) at the model's
 *   endpoints through fal's queue over plain `fetch` (`fal-queue-transport.ts`, no SDK since the
 *   owner's «Убрать SDK»): submit → poll status → result, the picture inside.
 *
 * Key constructs:
 * - One deadline for the whole job and one owner of it: its signal goes into every request and
 *   every pause (between polls, before a retry), and when the call gives up on an accepted job
 *   (the deadline passed, fal's answers failed, the ledger failed) it asks fal to cancel the job,
 *   the cancel bounded on its own (`cancelTimeoutMs`) and its failure dropped. The signal is
 *   aborted when the call ends, which cuts off anything of the job still running.
 * - One submit per call, never repeated: a second one after fal accepted the job would order a
 *   second paid picture. A connection that never opened (refused, unknown host, connect timeout, a
 *   refused TLS certificate, on every address of the host) sent nothing: an outage. The job is
 *   named by the body's `request_id` of the form of one, else by the `x-fal-request-id` header (a
 *   body that broke off, is empty or names no such id).
 * - The job is polled every `pollIntervalMs` until fal reports it `COMPLETED`. A poll, a result
 *   and a cancel are asked again as SDK 1.10.1 asked them (the transport); once a poll or a
 *   result runs out of retries the outcome is unknown, and the job is cancelled.
 * - `sync_mode`: the picture comes back inside the result as a data URI (probe of 22 November 2026:
 *   a 2000×1200 JPEG of 204 KB). Nothing is fetched from fal's CDN, which a server may not reach,
 *   and fal keeps no copy in its request history; a link instead of the picture is not followed.
 * - fal's verdict by its status and codes (fal.ai/docs/model-apis/errors): the codes of the body
 *   (`error_type`, `type`, the first 32 entries of `detail[].type`), or of an error answer's
 *   `X-Fal-Error-Type` header when the body names none or broke off. A 422 is a rejection, told to
 *   the model by its reason (content policy, the source, anything else); a refused submit is an
 *   outage (key, balance, access, model, rate), a rejection (other 4xx) or unknown (408, 499,
 *   5xx and above); a job fal ended with an error (any `error_type` in the final status, a result
 *   5xx with a known code) produced nothing and is an outage; anything else after an accepted job
 *   is ambiguous, so a replay never orders a second picture. Only these codes reach the log, never
 *   fal's messages: they may echo the prompt or a reference.
 * - fal returns no amount; the log carries the model's tariff as an estimate.
 */
import { isAppError, type AppError } from "../app-error.js";
import { asRecord } from "../json-value.js";
import { deadlineSignal } from "../request-signal.js";
import { assertReferenceCount, prepareUploadReference } from "./image-editing-input.js";
import { FAL_IMAGE_MODELS, type FalImageModelId } from "./fal-image-models.js";
import {
  falQueueTransport,
  pause,
  QUEUE_ORIGIN,
  QUEUE_RETRIES,
  STATUS_RETRIES,
  type QueueAnswer,
} from "./fal-queue-transport.js";
import {
  ambiguous,
  imageFromDataUri,
  rejected,
  reportProviderJob,
  unavailable,
  type ImageProviderClient,
  type RejectionReason,
} from "./image-provider.js";

const PROVIDER = "fal";
const POLL_INTERVAL_MS = 2_000;
/** Submit, queue, generation and the result with its picture, together. */
const JOB_TIMEOUT_MS = 4 * 60 * 1_000;
const CANCEL_TIMEOUT_MS = 10_000;
const REQUEST_ID_HEADER = "x-fal-request-id";
const ERROR_TYPE_HEADER = "x-fal-error-type";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

/** Codes of a job that ran into nothing: the platform could not run it, or the model failed. */
const FAILED_JOB_CODES = new Set([
  "client_cancelled",
  "downstream_service_error",
  "downstream_service_unavailable",
  "generation_timeout",
  "internal_error",
  "internal_server_error",
  "request_timeout",
  "runner_connection_error",
  "runner_connection_refused",
  "runner_connection_timeout",
  "runner_disconnected",
  "runner_incomplete_response",
  "runner_scheduling_failure",
  "runner_server_error",
  "startup_timeout",
]);
const SOURCE_CODES = new Set([
  "face_detection_error",
  "file_download_error",
  "file_too_large",
  "image_load_error",
  "image_too_large",
  "image_too_small",
  "unsupported_image_format",
]);

/**
 * Entries of a `detail` array read for codes: a validation error lists one per invalid field of
 * the request, fal's own errors one. Reading more would only lengthen the log line.
 */
const DETAIL_ENTRIES_READ = 32;

/** fal's machine-readable codes of an error body or status, each once; free text never leaves. */
function errorCodes(body: unknown): string[] {
  const record = asRecord(body);
  const codes = [record?.error_type, record?.type];
  const detail = record?.detail;
  if (Array.isArray(detail)) {
    for (const entry of detail.slice(0, DETAIL_ENTRIES_READ)) codes.push(asRecord(entry)?.type);
  }
  return [...new Set(codes)].filter(
    (code): code is string => typeof code === "string" && CODE_PATTERN.test(code),
  );
}

/** The refusal these codes name, or null when they name none. */
function rejectionReason(codes: readonly string[]): RejectionReason | null {
  if (codes.includes("content_policy_violation")) return "content";
  if (codes.some((code) => SOURCE_CODES.has(code))) return "source";
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A refused submit that ordered nothing: the key, the balance, the access, the model, the rate. */
const UNAVAILABLE_STATUSES = new Set([401, 402, 403, 404, 429]);
/**
 * Connection errors before any byte of the request went out (undici's `cause`): a failed name
 * lookup or connect (by its `syscall`, or by code where undici gives none), and a TLS certificate
 * refused during the handshake: `CERT_*` and the rest of the "X509 certificate error codes" of
 * Node's tls docs (v24), with Node's own `ERR_TLS_CERT_ALTNAME_INVALID`.
 */
const UNSENT_CODES = new Set([
  "CRL_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "OUT_OF_MEM",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const UNSENT_SYSCALLS = new Set(["connect", "getaddrinfo"]);

/** Whether one low-level error failed before sending, by its code or by the call that failed. */
function isUnsent(error: Record<string, unknown> | null): boolean {
  const code = error?.code;
  if (typeof code !== "string") return false;
  const syscall = error?.syscall;
  return (
    UNSENT_CODES.has(code) ||
    code.startsWith("CERT_") ||
    (typeof syscall === "string" && UNSENT_SYSCALLS.has(syscall))
  );
}

function unsentCode(error: unknown): string | null {
  const cause = error instanceof Error ? asRecord(error.cause) : null;
  const code = cause?.code;
  if (typeof code !== "string") return null;
  // Happy Eyeballs: Node tried each address of the host and reports an `AggregateError` with the
  // first failure's code and no `syscall`. Nothing went out only if no address took the request.
  const addresses = cause?.errors;
  const unsent =
    Array.isArray(addresses) && addresses.length > 0
      ? addresses.every((address) => isUnsent(asRecord(address)))
      : isUnsent(cause);
  return unsent ? code : null;
}

/** A submit fal answered with `status` (null: no answer we could read) and these codes. */
function submitFailure(status: number | null, codes: readonly string[]): AppError {
  const detail = `submit ${status ?? "network"} ${codes.join(",")}`.trim();
  // A gateway error (or a status past 599), a timeout, a dropped client, a broken connection or a
  // 3xx that is no redirect (300, 304 pass `redirect: "error"`): fal may have the job.
  if (status === null || status < 400 || status === 408 || status === 499 || status >= 500) {
    return ambiguous(PROVIDER, detail);
  }
  if (UNAVAILABLE_STATUSES.has(status)) return unavailable(PROVIDER, detail);
  return rejected(
    PROVIDER,
    detail,
    status === 413 ? "source" : (rejectionReason(codes) ?? "other"),
  );
}

/** fal's codes of an answer: its body's, else, of an error answer, its `X-Fal-Error-Type`. */
function answerCodes(answer: QueueAnswer): string[] {
  const codes = errorCodes(answer.body);
  if (codes.length > 0 || answer.ok) return codes;
  const named = answer.headers.get(ERROR_TYPE_HEADER);
  return named !== null && CODE_PATTERN.test(named) ? [named] : [];
}

export function createFalImageClient(options: {
  apiKey: string;
  cancelTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  model: FalImageModelId;
  pollIntervalMs?: number;
  /** The first pause before a retry, doubling after it (1 s, as the SDK's). */
  retryBaseDelayMs?: number;
  timeoutMs?: number;
}): ImageProviderClient {
  const model = FAL_IMAGE_MODELS[options.model];
  const queue = falQueueTransport({
    apiKey: options.apiKey,
    fetch: options.fetch ?? globalThis.fetch,
    retryBaseDelayMs: options.retryBaseDelayMs,
  });
  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  async function submit(
    endpoint: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    let answer: QueueAnswer;
    try {
      answer = await queue.send("POST", `${QUEUE_ORIGIN}/${endpoint}`, signal, input);
    } catch (error) {
      const unsent = unsentCode(error);
      throw unsent === null
        ? submitFailure(null, [])
        : unavailable(PROVIDER, `submit unsent ${unsent}`);
    }
    if (!answer.ok) throw submitFailure(answer.status, answerCodes(answer));
    const named = [asRecord(answer.body)?.request_id, answer.headers.get(REQUEST_ID_HEADER)].find(
      (id): id is string => typeof id === "string" && REQUEST_ID_PATTERN.test(id),
    );
    if (named === undefined) throw ambiguous(PROVIDER, "request id missing");
    return named;
  }

  /** The job's status once fal reports it done; any other answer ends the call as unknown. */
  async function poll(job: string, signal: AbortSignal): Promise<QueueAnswer> {
    for (;;) {
      const answer = await queue.sendWithRetries(
        "GET",
        `${job}/status?logs=0`,
        STATUS_RETRIES,
        signal,
      );
      if (!answer.ok) throw ambiguous(PROVIDER, `status ${answer.status}`);
      const state = asRecord(answer.body)?.status;
      if (state === "COMPLETED") return answer;
      // Neither waiting nor done (a body that is not JSON or names no status fal sends): there is
      // no outcome to wait for, and waiting held the call to its deadline.
      if (state !== "IN_QUEUE" && state !== "IN_PROGRESS") {
        throw ambiguous(PROVIDER, `status unreadable ${answer.status}`);
      }
      await pause(pollIntervalMs, signal);
    }
  }

  async function collect(
    endpoint: string,
    job: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<string> {
    let status: QueueAnswer;
    try {
      status = await poll(job, signal);
    } catch (error) {
      if (isAppError(error)) throw error;
      throw ambiguous(PROVIDER, `status ${errorName(error)}`);
    }
    const failure = answerCodes(status);
    if (failure.length > 0) {
      // fal ended the job with an error: nothing was made. A refusal by the model keeps its advice.
      const detail = `${endpoint} job ${requestId} ${failure.join(",")}`;
      const reason = rejectionReason(failure);
      throw reason === null ? unavailable(PROVIDER, detail) : rejected(PROVIDER, detail, reason);
    }
    let result: QueueAnswer;
    try {
      result = await queue.sendWithRetries("GET", job, QUEUE_RETRIES, signal);
    } catch (error) {
      throw ambiguous(PROVIDER, `result ${errorName(error)}`);
    }
    if (!result.ok) {
      const codes = answerCodes(result);
      const detail = `${endpoint} job ${requestId} ${result.status} ${codes.join(",")}`.trim();
      if (result.status === 422) {
        throw rejected(PROVIDER, detail, rejectionReason(codes) ?? "other");
      }
      if (codes.some((code) => FAILED_JOB_CODES.has(code))) throw unavailable(PROVIDER, detail);
      throw ambiguous(PROVIDER, detail);
    }
    const images = asRecord(result.body)?.images;
    const picture = Array.isArray(images) ? asRecord(images[0])?.url : undefined;
    if (typeof picture !== "string") throw ambiguous(PROVIDER, "result picture missing");
    return picture;
  }

  return {
    async generate(input) {
      const references = input.referenceImages ?? [];
      const endpoint = references.length > 0 ? model.edit : model.textToImage;
      const request: Record<string, unknown> = {
        ...model.fixed,
        background: input.background,
        image_size: model.sizes[input.size],
        num_images: 1,
        output_format: input.background === "transparent" ? "png" : "jpeg",
        prompt: input.prompt,
        sync_mode: true,
      };
      if (references.length > 0) {
        assertReferenceCount(references);
        const urls: string[] = [];
        for (const [index, reference] of references.entries()) {
          const bytes = await prepareUploadReference(reference, index);
          urls.push(`data:image/jpeg;base64,${bytes.toString("base64")}`);
        }
        request.image_urls = urls;
      }
      const ended = new AbortController();
      const signal = deadlineSignal(timeoutMs, ended.signal);
      // fal keeps a job under its app, the endpoint's first two segments (SDK `parseEndpointId`).
      const app = `${QUEUE_ORIGIN}/${endpoint.split("/").slice(0, 2).join("/")}`;
      let job: string | null = null;
      let picture: string;
      try {
        const requestId = await submit(endpoint, request, signal);
        job = `${app}/requests/${requestId}`;
        await reportProviderJob(input, { jobId: requestId, model: endpoint, provider: PROVIDER });
        picture = await collect(endpoint, job, requestId, signal);
      } catch (error) {
        // An accepted job nobody waits for: fal drops it while it is still queued. The job's signal
        // ends below, so the cancel is bounded on its own; fal may refuse a job it no longer has.
        if (job !== null) {
          void queue
            .sendWithRetries(
              "PUT",
              `${job}/cancel`,
              QUEUE_RETRIES,
              AbortSignal.timeout(cancelTimeoutMs),
            )
            .catch(() => undefined);
        }
        if (isAppError(error)) throw error;
        throw ambiguous(PROVIDER, errorName(error));
      } finally {
        // Nothing of this job but its cancel outlives it: a late poll stops here.
        ended.abort();
      }
      console.log(
        JSON.stringify({
          code: "AGENT_IMAGE_GENERATION_BILLED",
          estimatedUsd: model.estimatedUsd(references.length),
          model: endpoint,
          provider: PROVIDER,
        }),
      );
      return await imageFromDataUri(picture, `${PROVIDER}/${endpoint}`, PROVIDER);
    },
  };
}
