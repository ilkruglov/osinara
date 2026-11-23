/**
 * Shared authorized image reads for vision and editing; never publishes Telegram URLs.
 * `unsuitableImageSource` tells a refusal of a file that another file would not meet.
 */
import { VISION_MAX_FILE_BYTES } from "../../config.js";
import { AppError, isAppError } from "../app-error.js";
import { downloadTelegramAttachment } from "../attachments/telegram-attachment-download.js";
import { telegramGroupAttachmentRepository } from "../attachments/telegram-group-attachment-repository.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import {
  workspaceBinaryRepository,
  type WorkspaceBinaryFile,
} from "./workspace-binary-repository.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "./workspace-repository.js";

export type WorkspaceImageLocation = { scope: WorkspaceScope } & (
  { attachmentId: string } | { path: string } | { telegramMessageId: string }
);

export interface WorkspaceImageReaderDependencies {
  authorizeScope(auth: WorkspaceAuthorization, scope: WorkspaceScope): Promise<void>;
  downloadTelegramAttachment: typeof downloadTelegramAttachment;
  findTelegramAttachment: typeof telegramGroupAttachmentRepository.find;
  readBinary(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    path: string,
  ): Promise<WorkspaceBinaryFile>;
  readTelegramInboxAttachment(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    id: string,
  ): Promise<WorkspaceBinaryFile>;
}

/** The storage (50 MB) and the Telegram download (20 MB) may refuse the size before the reader. */
const UNSUITABLE_IMAGE_SOURCE: ReadonlySet<string> = new Set([
  "AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE",
  "AGENT_WORKSPACE_FILE_TOO_LARGE",
  "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE",
  "AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED",
]);

/**
 * The reader's refusal of a file another file would not meet (too large, not a still image it can
 * read), with its reason, or null for any other error. The tools that read images tell the model to
 * take another file instead of an operation of unknown outcome (repeat review, 23 November 2026).
 */
export function unsuitableImageSource(error: unknown): { code: string; reason: string } | null {
  if (!isAppError(error) || !UNSUITABLE_IMAGE_SOURCE.has(error.code)) return null;
  // `AppError` writes its message as `${code}: ${reason}`.
  return { code: error.code, reason: error.message.slice(error.code.length + 2) };
}

/**
 * The image types the vision model reads (DeepSeek: JPEG, PNG, GIF and WebP, judged by content,
 * api-docs.deepseek.com/guides/vision; an animated PNG is a PNG to it). A workspace file is typed by
 * its bytes when it is read; any image type went on, and a TIFF failed at the model as the
 * provider's fault (repeat review, 23 November 2026). Editing decodes JPEG, PNG and WebP only and
 * refuses the rest itself.
 */
const VISION_READABLE_TYPES: ReadonlySet<string> = new Set([
  "image/apng",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function assertImageSize(size: number): void {
  if (size > VISION_MAX_FILE_BYTES) {
    throw new AppError(
      "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE",
      "Изображение должно быть размером не более 10 МБ",
    );
  }
}

export function createWorkspaceImageReader(dependencies: WorkspaceImageReaderDependencies) {
  return async (auth: WorkspaceAuthorization, input: WorkspaceImageLocation) => {
    await dependencies.authorizeScope(auth, input.scope);
    if ("attachmentId" in input) {
      const allowed =
        (auth.groupType === "family_private" && input.scope === "family") ||
        (auth.groupType === "external" && input.scope === "group");
      if (!allowed) {
        throw new AppError(
          "AGENT_TELEGRAM_ATTACHMENT_ACCESS_DENIED",
          "Вложение недоступно в текущей группе и области файлов",
        );
      }
      const reference = await dependencies.findTelegramAttachment(auth, input.attachmentId);
      if (reference.attachment.size !== undefined) assertImageSize(reference.attachment.size);
      const bytes = await dependencies.downloadTelegramAttachment(reference.attachment);
      assertImageSize(bytes.byteLength);
      const mediaType = await validateVisionImageBytes(bytes);
      return {
        bytes,
        mediaType,
        scope: input.scope,
        source: {
          attachmentId: input.attachmentId,
          kind: reference.attachment.kind,
          mediaType,
          size: bytes.byteLength,
          telegramMessageId: reference.messageId,
        },
      };
    }
    const binary =
      "telegramMessageId" in input
        ? await dependencies.readTelegramInboxAttachment(auth, input.scope, input.telegramMessageId)
        : await dependencies.readBinary(auth, input.scope, input.path);
    if (!VISION_READABLE_TYPES.has(binary.file.mediaType)) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED",
        "Из workspace можно открыть только изображение JPEG, PNG, GIF или WebP",
      );
    }
    assertImageSize(binary.bytes.byteLength);
    return {
      bytes: binary.bytes,
      mediaType: binary.file.mediaType,
      path: binary.file.path,
      scope: binary.file.scope,
    };
  };
}

export const workspaceImageReaderDependencies: WorkspaceImageReaderDependencies = {
  authorizeScope: workspaceBinaryRepository.authorizeScope,
  downloadTelegramAttachment,
  findTelegramAttachment: telegramGroupAttachmentRepository.find,
  readBinary: workspaceBinaryRepository.readBinary,
  readTelegramInboxAttachment: workspaceBinaryRepository.readTelegramInboxAttachment,
};

export const readWorkspaceImage = createWorkspaceImageReader(workspaceImageReaderDependencies);
