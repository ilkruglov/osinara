/**
 * Authorized Telegram attachment ingestion.
 *
 * Exports:
 * - `StoredTelegramAttachment`: trusted persistent path advertised to the model.
 * - `createTelegramWorkspaceAttachmentImporter`: download, validate, and persist pipeline; `stored`
 *   finds what earlier messages of the chat stored, for the turn of a series' last message.
 */
import type { TelegramAttachment } from "eve/channels/telegram";

import { TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE } from "../../config.js";
import { AppError, isAppError } from "../app-error.js";
import type {
  WorkspaceAuthorization,
  WorkspaceFileRecord,
  WorkspaceScope,
} from "../workspaces/workspace-repository.js";
import {
  validateAttachmentContent,
  validateReadableTextAttachmentContent,
} from "./attachment-policy.js";
import { telegramInboxDirectory } from "./telegram-inbox-path.js";

interface AttachmentImporterDependencies {
  download(attachment: TelegramAttachment): Promise<Uint8Array>;
  findBinaryWritesByKeyPrefixes(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    prefixes: readonly string[],
  ): Promise<WorkspaceFileRecord[][]>;
  listFilesUnder(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    directory: string,
  ): Promise<Array<{ path: string; updatedAt: Date }>>;
  writeBinary(
    auth: WorkspaceAuthorization,
    input: {
      bytes: Uint8Array;
      mediaType: string;
      operationKey: string;
      path: string;
      scope: WorkspaceScope;
    },
  ): Promise<WorkspaceFileRecord>;
}

export interface StoredTelegramAttachment {
  mediaType: string;
  path: string;
  scope: WorkspaceScope;
  telegramMessageId: string;
}

const MEDIA_TYPE_DEFAULT_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": ".json",
  "application/msword": ".doc",
  "application/pdf": ".pdf",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

function defaultAttachmentName(attachment: TelegramAttachment, index: number): string {
  if (attachment.fileName) return attachment.fileName;
  const identity = attachment.fileUniqueId ?? String(index + 1);
  const extension =
    attachment.kind === "photo"
      ? ".jpg"
      : attachment.mediaType
        ? MEDIA_TYPE_DEFAULT_EXTENSIONS[attachment.mediaType]
        : undefined;
  // Telegram file names are optional presentation metadata. Keep an opaque document storable even
  // when neither Telegram nor content detection can provide a meaningful extension.
  return `${attachment.kind}-${identity}${extension ?? ""}`;
}

/** One replay key per stored file of a message; its prefix finds them all later. */
function attachmentOperationPrefix(chatId: string, messageId: string): string {
  return `telegram-attachment:${chatId}:${messageId}:`;
}

function assertTelegramMessageId(value: string): void {
  if (!/^\d+$/u.test(value)) {
    throw new Error("AGENT_TELEGRAM_MESSAGE_ID_INVALID: Telegram message ID must be numeric");
  }
}

export function createTelegramWorkspaceAttachmentImporter(
  dependencies: AttachmentImporterDependencies,
) {
  return {
    async persist(input: {
      attachments: readonly TelegramAttachment[];
      auth: WorkspaceAuthorization;
      chatId: string;
      messageId: string;
      scope: WorkspaceScope;
    }): Promise<StoredTelegramAttachment[]> {
      assertTelegramMessageId(input.messageId);
      const inboxDirectory = telegramInboxDirectory(input.auth, input.scope, input.messageId);
      if (input.attachments.length > TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new AppError(
          "AGENT_ATTACHMENT_COUNT_EXCEEDED",
          "Одно сообщение Telegram может содержать только один обрабатываемый файл",
        );
      }
      const stored: StoredTelegramAttachment[] = [];
      for (const [index, attachment] of input.attachments.entries()) {
        const bytes = await dependencies.download(attachment);
        // Restricted groups persist only files that Eve's text-only read_file can consume.
        const validator =
          input.scope === "group"
            ? validateReadableTextAttachmentContent
            : validateAttachmentContent;
        const validated = await validator({
          bytes,
          ...(attachment.mediaType ? { declaredMediaType: attachment.mediaType } : {}),
          fileName: defaultAttachmentName(attachment, index),
          kind: attachment.kind,
        });

        // Content validation establishes the stored MIME and safe filename before persistence.
        const path = `${inboxDirectory}/${validated.fileName}`;
        const file = await dependencies.writeBinary(input.auth, {
          bytes,
          mediaType: validated.mediaType,
          operationKey: `${attachmentOperationPrefix(input.chatId, input.messageId)}${attachment.fileUniqueId ?? attachment.fileId}`,
          path,
          scope: input.scope,
        });
        stored.push({
          mediaType: file.mediaType,
          path: file.path,
          scope: file.scope,
          telegramMessageId: input.messageId,
        });
      }
      return stored;
    },

    /**
     * Files earlier messages of the chat stored and the workspace still holds, in message order: an
     * earlier photo of a series starts no turn, and the last message's turn lists it.
     */
    async stored(input: {
      auth: WorkspaceAuthorization;
      chatId: string;
      messageIds: readonly string[];
      scope: WorkspaceScope;
    }): Promise<StoredTelegramAttachment[]> {
      for (const messageId of input.messageIds) assertTelegramMessageId(messageId);
      // One lookup for every message: most of a series is text, with no file to list.
      const writes = await dependencies.findBinaryWritesByKeyPrefixes(
        input.auth,
        input.scope,
        input.messageIds.map((messageId) => attachmentOperationPrefix(input.chatId, messageId)),
      );
      const stored: StoredTelegramAttachment[] = [];
      for (const [index, messageId] of input.messageIds.entries()) {
        const files = writes[index] ?? [];
        if (files.length === 0) continue;
        // The inbox is shared with the sandbox: a directory it turned into a link or a file is
        // read as holding nothing, and the turn goes on without those files.
        let present: Map<string, string>;
        try {
          const listed = await dependencies.listFilesUnder(
            input.auth,
            input.scope,
            telegramInboxDirectory(input.auth, input.scope, messageId),
          );
          present = new Map(listed.map((file) => [file.path, file.updatedAt.toISOString()]));
        } catch (error) {
          if (!isAppError(error)) throw error;
          console.warn(
            JSON.stringify({
              code: "AGENT_TELEGRAM_INBOX_UNREADABLE",
              error: error.code,
              messageId,
            }),
          );
          continue;
        }
        for (const file of files) {
          // Its time is the stored write's own: a file rewritten in place is not that attachment.
          if (present.get(file.path) !== file.updatedAt) continue;
          stored.push({
            mediaType: file.mediaType,
            path: file.path,
            scope: file.scope,
            telegramMessageId: messageId,
          });
        }
      }
      return stored;
    },
  };
}
