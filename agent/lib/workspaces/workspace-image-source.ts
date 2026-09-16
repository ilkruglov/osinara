/** Shared authorized image reads for vision and editing; never publishes Telegram URLs. */
import { VISION_MAX_FILE_BYTES } from "../../config.js";
import { AppError } from "../app-error.js";
import { downloadTelegramAttachment } from "../attachments/telegram-attachment-download.js";
import { telegramGroupAttachmentRepository } from "../attachments/telegram-group-attachment-repository.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import { workspaceBinaryRepository, type WorkspaceBinaryFile } from "./workspace-binary-repository.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "./workspace-repository.js";

export type WorkspaceImageLocation = { scope: WorkspaceScope } & (
  | { attachmentId: string }
  | { path: string }
  | { telegramMessageId: string }
);

export interface WorkspaceImageReaderDependencies {
  authorizeScope(auth: WorkspaceAuthorization, scope: WorkspaceScope): Promise<void>;
  downloadTelegramAttachment: typeof downloadTelegramAttachment;
  findTelegramAttachment: typeof telegramGroupAttachmentRepository.find;
  readBinary(auth: WorkspaceAuthorization, scope: WorkspaceScope, path: string): Promise<WorkspaceBinaryFile>;
  readTelegramInboxAttachment(auth: WorkspaceAuthorization, scope: WorkspaceScope, id: string): Promise<WorkspaceBinaryFile>;
}

function assertImageSize(size: number): void {
  if (size > VISION_MAX_FILE_BYTES) {
    throw new AppError("AGENT_WORKSPACE_VISION_FILE_TOO_LARGE", "Изображение должно быть размером не более 10 МБ");
  }
}

export function createWorkspaceImageReader(dependencies: WorkspaceImageReaderDependencies) {
  return async (auth: WorkspaceAuthorization, input: WorkspaceImageLocation) => {
    await dependencies.authorizeScope(auth, input.scope);
    if ("attachmentId" in input) {
      const allowed = auth.groupType === "family_private" && input.scope === "family" ||
        auth.groupType === "external" && input.scope === "group";
      if (!allowed) {
        throw new AppError("AGENT_TELEGRAM_ATTACHMENT_ACCESS_DENIED", "Вложение недоступно в текущей группе и области файлов");
      }
      const reference = await dependencies.findTelegramAttachment(auth, input.attachmentId);
      if (reference.attachment.size !== undefined) assertImageSize(reference.attachment.size);
      const bytes = await dependencies.downloadTelegramAttachment(reference.attachment);
      assertImageSize(bytes.byteLength);
      const mediaType = await validateVisionImageBytes(bytes);
      return {
        bytes, mediaType, scope: input.scope,
        source: {
          attachmentId: input.attachmentId, kind: reference.attachment.kind, mediaType,
          size: bytes.byteLength, telegramMessageId: reference.messageId,
        },
      };
    }
    const binary = "telegramMessageId" in input
      ? await dependencies.readTelegramInboxAttachment(auth, input.scope, input.telegramMessageId)
      : await dependencies.readBinary(auth, input.scope, input.path);
    if (!binary.file.mediaType.startsWith("image/")) {
      throw new AppError("AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED", "Из workspace можно открыть только файл изображения");
    }
    assertImageSize(binary.bytes.byteLength);
    return { bytes: binary.bytes, mediaType: binary.file.mediaType, path: binary.file.path, scope: binary.file.scope };
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
