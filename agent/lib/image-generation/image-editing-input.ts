/** Bounded raster decoding for image-editing references, with orientation and without metadata. */
import sharp from "sharp";
import { AppError } from "../app-error.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import type { ImageReference } from "./image-generation-client.js";

/** Cloudflare klein-4b requires both dimensions below 512. */
const CLOUDFLARE_MAX_SIDE = 511;
/** Async providers take the picture as is; this only bounds the upload, not the output. */
const UPLOAD_MAX_SIDE = 1_536;
export const MIN_REFERENCE_IMAGES = 1;
export const MAX_REFERENCE_IMAGES = 4;

export function editingUnavailable(): AppError {
  return new AppError(
    "AGENT_IMAGE_EDITING_UNAVAILABLE",
    "Редактирование изображений недоступно: требуется настроенный сервис правки (PlusVibe, NeuralDeep или Cloudflare Workers AI)",
  );
}

export function assertReferenceCount(references: readonly ImageReference[]): void {
  if (references.length < MIN_REFERENCE_IMAGES || references.length > MAX_REFERENCE_IMAGES) {
    throw new AppError("AGENT_IMAGE_EDITING_INPUT_INVALID", "Передайте от одного до четырёх исходников");
  }
}

async function prepareReference(image: ImageReference, maxSide: number): Promise<Buffer> {
  try {
    if (image.bytes.byteLength > 10 * 1024 * 1024) throw new Error("Image exceeds byte limit");
    await validateVisionImageBytes(image.bytes);
    const decoder = sharp(image.bytes, { failOn: "warning", limitInputPixels: 40_000_000 });
    const metadata = await decoder.metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1) {
      throw new Error("Unsupported static image");
    }
    // Preserve the whole image and its aspect ratio; only the longer side is bounded.
    return await decoder.rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      .png().toBuffer();
  } catch {
    throw new AppError("AGENT_IMAGE_EDITING_INPUT_INVALID", "Не удалось прочитать исходник: нужен неповреждённый PNG, JPEG или WebP до 10 МБ и 40 мегапикселей");
  }
}

export function prepareCloudflareReference(image: ImageReference): Promise<Buffer> {
  return prepareReference(image, CLOUDFLARE_MAX_SIDE);
}

/** PNG for providers that upload the reference (multipart or base64) and keep its size. */
export function prepareUploadReference(image: ImageReference): Promise<Buffer> {
  return prepareReference(image, UPLOAD_MAX_SIDE);
}
