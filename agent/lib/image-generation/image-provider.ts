/**
 * The image provider's shared contract and failure handling, apart from its transport.
 *
 * Exports:
 * - `ImageProviderClient`: the configured provider (fal.ai since 22 November 2026).
 * - `reportProviderJob`: names an accepted job before its outcome is known.
 * - `unavailable`, `ambiguous`, `rejected`: the three failure kinds, logged with codes only. An
 *   outage and a rejection made nothing, and the model hears so (not "it may have been billed");
 *   a rejection it may correct once by its reason (`RejectionReason`).
 * - `imageFromDataUri`, `imageFromBytes`: the picture of a result, bounded before decoding, typed
 *   by its content (`file-type`) rather than by what the provider says, and of one frame only.
 */
import sharp from "sharp";

import { AppError } from "../app-error.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import { ModelFacingError } from "../model-facing-error.js";
import { IMAGE_DECODE_PIXEL_LIMIT } from "./image-editing-input.js";
import type {
  GeneratedImage,
  ImageGenerationRequest,
  ImageMediaType,
  ProviderJob,
} from "./image-generation-client.js";

const MAX_IMAGE_BYTES = 32 * 1_024 * 1_024;
export const PROVIDER_JOB_RECORD_TIMEOUT_MS = 5_000;

export interface ImageProviderClient {
  generate(input: ImageGenerationRequest): Promise<GeneratedImage>;
}

/**
 * An accepted job is named before its outcome is known: the log and the caller's ledger get the
 * provider, model and job id, so a poll that times out can still be reconciled with the provider.
 * On 16 October 2026 four timed-out jobs could not be checked because nothing kept their ids.
 */
export async function reportProviderJob(
  input: ImageGenerationRequest,
  job: ProviderJob,
): Promise<void> {
  console.info(
    JSON.stringify({
      code: "AGENT_IMAGE_GENERATION_JOB",
      jobId: job.jobId,
      model: job.model,
      provider: job.provider,
    }),
  );
  if (input.onProviderJob === undefined) return;
  // The job is already running at the provider: a slow ledger must not delay collecting it. The
  // caller's hook keeps running on its own; the poll starts after this bounded wait.
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PROVIDER_JOB_RECORD_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([
      input.onProviderJob(job).then(() => "recorded" as const),
      expired,
    ]);
    if (outcome === "timeout") {
      console.warn(
        JSON.stringify({
          code: "AGENT_IMAGE_GENERATION_JOB_RECORD_TIMEOUT",
          jobId: job.jobId,
          provider: job.provider,
        }),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Nothing was produced: the tool's generic envelope would call the outcome unknown, maybe billed. */
export function unavailable(provider: string, detail: string): ModelFacingError {
  console.error(
    JSON.stringify({ code: "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE", detail, provider }),
  );
  return new ModelFacingError({
    category: "dependency",
    code: "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE",
    correction: "Не повторяйте вызов автоматически: картинки нет; сообщите об этом пользователю.",
    reason: "Сервис генерации изображений сейчас недоступен",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

/** The provider may have produced (and billed) the image; a replay must not order it again. */
export function ambiguous(provider: string, detail: string): AppError {
  console.error(JSON.stringify({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS", detail, provider }));
  return new AppError(
    "AGENT_IMAGE_GENERATION_AMBIGUOUS",
    "Не удалось подтвердить результат генерации. Проверьте результат перед новым запросом",
  );
}

/** Why the provider refused: what the model is told to change differs. */
export type RejectionReason = "content" | "other" | "source";

const REJECTIONS: Readonly<
  Record<RejectionReason, { correction: string; field: string; reason: string }>
> = {
  content: {
    correction:
      "Уберите из prompt названия брендов, марок и персон, смягчите сцену (насилие, откровенность) " +
      "и опишите объект своими словами; если передан исходник, фильтр мог остановить его, тогда " +
      "возьмите другой.",
    field: "prompt",
    reason: "Фильтр сервиса генерации изображений отклонил запрос",
  },
  other: {
    correction: "Переформулируйте prompt проще.",
    field: "prompt",
    reason: "Сервис генерации изображений отклонил запрос",
  },
  source: {
    correction:
      "Возьмите другую, неповреждённую картинку подходящего размера (для правки человека — с " +
      "хорошо видным лицом) или передайте меньше исходников.",
    field: "images",
    reason: "Сервис генерации изображений не принял исходник",
  },
};

/**
 * A refusal made nothing: an input the model may correct once, not an outcome that may have been
 * billed. The tool's generic envelope would say both "try again" and "do not repeat, it may have
 * been charged".
 */
export function rejected(
  provider: string,
  detail: string,
  reason: RejectionReason,
): ModelFacingError {
  console.error(
    JSON.stringify({ code: "AGENT_IMAGE_GENERATION_REJECTED", detail, provider, reason }),
  );
  const { correction, field, reason: why } = REJECTIONS[reason];
  return new ModelFacingError({
    category: "input",
    code: "AGENT_IMAGE_GENERATION_REJECTED",
    correction: `${correction} Повторите вызов один раз; при новом отказе сообщите пользователю.`,
    field,
    reason: why,
    retryable: true,
    sideEffectStatus: "not_started",
  });
}

export async function imageFromBytes(
  bytes: Buffer,
  model: string,
  provider: string,
): Promise<GeneratedImage> {
  let mediaType: ImageMediaType;
  try {
    mediaType = await validateVisionImageBytes(bytes);
  } catch {
    throw ambiguous(provider, "unknown image format");
  }
  // A signature says what the file claims to be; only decoding it shows a whole picture. sharp
  // decodes the first frame only, so a picture of several would keep frames nobody checked.
  let frames: number;
  try {
    const decoder = sharp(bytes, { limitInputPixels: IMAGE_DECODE_PIXEL_LIMIT });
    frames = (await decoder.metadata()).pages ?? 1;
    if (frames === 1) await decoder.raw().toBuffer();
  } catch {
    throw ambiguous(provider, "image not decodable");
  }
  if (frames !== 1) throw ambiguous(provider, "image has several frames");
  return { bytes, mediaType, model };
}

/** base64 of `MAX_IMAGE_BYTES`: a longer inline picture is refused before it is decoded. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const IMAGE_DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,/u;

/** The picture a provider returned inline (`sync_mode`); a link or anything else is unknown. */
export async function imageFromDataUri(
  dataUri: string,
  model: string,
  provider: string,
): Promise<GeneratedImage> {
  const prefix = IMAGE_DATA_URI.exec(dataUri)?.[0];
  if (prefix === undefined) throw ambiguous(provider, "result picture not inline");
  if (dataUri.length - prefix.length > MAX_BASE64_LENGTH) {
    throw ambiguous(provider, "image too large");
  }
  const bytes = Buffer.from(dataUri.slice(prefix.length), "base64");
  // The base64 length bounds the picture only to its last block of three bytes.
  if (bytes.length > MAX_IMAGE_BYTES) throw ambiguous(provider, "image too large");
  return await imageFromBytes(bytes, model, provider);
}
