/**
 * Telegram static-image attachment policy.
 *
 * Exports:
 * - `isTelegramImageDocumentCandidate`: validates pre-download document metadata.
 * - `validateVisionImageBytes`: derives the authoritative supported MIME from downloaded bytes.
 */
import { extname } from "node:path";

import type { TelegramAttachment } from "eve/channels/telegram";
import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../app-error.js";

export type VisionImageMediaType = "image/jpeg" | "image/png" | "image/webp";

const VISION_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<VisionImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isVisionImageMediaType(mime: string): mime is VisionImageMediaType {
  return VISION_IMAGE_MEDIA_TYPES.has(mime);
}

const VISION_IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

export function isTelegramImageDocumentCandidate(
  attachment: Pick<TelegramAttachment, "fileName" | "kind" | "mediaType">,
): boolean {
  if (attachment.kind !== "document") return false;
  return (
    attachment.mediaType?.toLowerCase().startsWith("image/") === true ||
    (attachment.fileName !== undefined &&
      VISION_IMAGE_EXTENSIONS.has(extname(attachment.fileName).toLowerCase()))
  );
}

export async function validateVisionImageBytes(bytes: Uint8Array): Promise<VisionImageMediaType> {
  // Downloaded magic bytes are authoritative; Telegram MIME and filename are only candidates.
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !isVisionImageMediaType(detected.mime)) {
    throw new AppError(
      "AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED",
      "Вложение не является поддерживаемым статическим изображением",
    );
  }
  return detected.mime;
}
