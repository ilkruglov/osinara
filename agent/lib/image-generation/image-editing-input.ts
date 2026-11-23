/** Bounded raster decoding for image-editing references, with orientation and without metadata. */
import sharp from "sharp";
import { AppError } from "../app-error.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import type { ImageReference } from "./image-generation-client.js";
import { correctableInputError } from "./image-generation-failures.js";

/** The provider takes the picture as is; this only bounds the upload, not the output. */
const UPLOAD_MAX_SIDE = 1_536;
/** The most pixels any picture is decoded at, a reference or a result: past it, a decode bomb. */
export const IMAGE_DECODE_PIXEL_LIMIT = 40_000_000;
const MAX_REFERENCE_IMAGES = 4;

export function assertReferenceCount(references: readonly ImageReference[]): void {
  if (references.length > MAX_REFERENCE_IMAGES) {
    throw new AppError(
      "AGENT_IMAGE_EDITING_INPUT_INVALID",
      "Передайте не больше четырёх исходников",
    );
  }
}

/**
 * JPEG with the longer side bounded to 1536, orientation applied and metadata dropped: four PNG
 * photos serialised as base64 reached 48 MiB of JSON.
 */
export async function prepareUploadReference(
  image: ImageReference,
  index: number,
): Promise<Buffer> {
  try {
    if (image.bytes.byteLength > 10 * 1024 * 1024) throw new Error("Image exceeds byte limit");
    await validateVisionImageBytes(image.bytes);
    const decoder = sharp(image.bytes, {
      failOn: "warning",
      limitInputPixels: IMAGE_DECODE_PIXEL_LIMIT,
    });
    const metadata = await decoder.metadata();
    if (
      !metadata.format ||
      !["jpeg", "png", "webp"].includes(metadata.format) ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error("Unsupported static image");
    }
    // Preserve the whole image and its aspect ratio; only the longer side is bounded.
    return await decoder
      .rotate()
      .resize({
        width: UPLOAD_MAX_SIDE,
        height: UPLOAD_MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch {
    // The model can take another source: the first refusal says so, as a replay of it does; a
    // generic «fix the arguments» left a valid call nothing to change. With several sources, which
    // one to replace is the advice itself.
    throw correctableInputError(
      "AGENT_IMAGE_EDITING_INPUT_INVALID",
      `Исходник ${index + 1}: не удалось прочитать, нужен неповреждённый PNG, JPEG или WebP до 10 МБ и 40 мегапикселей`,
      `images[${index}]`,
    );
  }
}
