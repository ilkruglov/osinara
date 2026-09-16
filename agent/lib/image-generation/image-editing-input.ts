/** Bounded raster decoding for Cloudflare image references, with orientation and without metadata. */
import sharp from "sharp";
import { AppError } from "../app-error.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import type { ImageReference } from "./image-generation-client.js";

export function editingUnavailable(): AppError {
  return new AppError("AGENT_IMAGE_EDITING_UNAVAILABLE", "Редактирование изображений недоступно: требуется настроенный Cloudflare Workers AI");
}

export async function prepareCloudflareReference(image: ImageReference): Promise<Buffer> {
  try {
    if (image.bytes.byteLength > 10 * 1024 * 1024) throw new Error("Image exceeds byte limit");
    await validateVisionImageBytes(image.bytes);
    const decoder = sharp(image.bytes, { failOn: "warning", limitInputPixels: 40_000_000 });
    const metadata = await decoder.metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1) {
      throw new Error("Unsupported static image");
    }
    // Cloudflare requires both dimensions below 512. Preserve the whole image and its aspect ratio.
    return await decoder.rotate().resize({ width: 511, height: 511, fit: "inside", withoutEnlargement: true })
      .png().toBuffer();
  } catch {
    throw new AppError("AGENT_IMAGE_EDITING_INPUT_INVALID", "Не удалось прочитать исходник: нужен неповреждённый PNG, JPEG или WebP до 10 МБ и 40 мегапикселей");
  }
}
