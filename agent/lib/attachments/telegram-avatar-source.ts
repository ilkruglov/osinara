/**
 * Telegram profile photos as picture references.
 *
 * Exports:
 * - `createTelegramAvatarSource`: testable `getUserProfilePhotos` + download coordinator.
 * - `pickAvatarSize`: the largest of Telegram's sizes that is still a reference, not a poster.
 * - `telegramAvatarSource`: production source through Eve's public Telegram API.
 *
 * Key constructs:
 * - One API call says whether the person shows a photo to the bot at all and which file it is;
 *   `file_unique_id` changes only when the photo changes, so the caller skips the download when
 *   the workspace already holds that file.
 * - "No photo" and "photo hidden from non-contacts" look the same to a bot: an empty list.
 */
import {
  callTelegramApi,
  downloadTelegramFile,
  getTelegramFile,
  type TelegramAttachment,
} from "eve/channels/telegram";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { createTelegramAttachmentDownloader } from "./telegram-attachment-download.js";

/** Telegram offers 160, 320 and 640 px; the largest at or under this is enough for a reference. */
const AVATAR_MAX_SIDE = 640;

const photoSizeSchema = z.object({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
  file_unique_id: z.string().min(1),
  height: z.number().int().positive(),
  width: z.number().int().positive(),
});
const profilePhotosSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    photos: z.array(z.array(photoSizeSchema)),
    total_count: z.number().int().nonnegative(),
  }),
});

export interface TelegramAvatarPhoto {
  fileId: string;
  fileUniqueId: string;
  height: number;
  size?: number;
  width: number;
}

export type TelegramAvatarLookup = { status: "none" } | { photo: TelegramAvatarPhoto; status: "photo" };

export interface TelegramAvatarSourceAdapter {
  download(attachment: TelegramAttachment): Promise<Buffer>;
  /** The parsed JSON body of `getUserProfilePhotos`, or a throw when the call itself failed. */
  profilePhotos(telegramUserId: string): Promise<unknown>;
}

export interface TelegramAvatarSource {
  download(photo: TelegramAvatarPhoto): Promise<Buffer>;
  lookup(telegramUserId: string): Promise<TelegramAvatarLookup>;
}

export function pickAvatarSize(sizes: readonly TelegramAvatarPhoto[]): TelegramAvatarPhoto {
  const fitting = sizes.filter((size) => Math.max(size.width, size.height) <= AVATAR_MAX_SIDE);
  // Nothing fits: the smallest is still a reference, the largest would be a download for nothing.
  if (fitting.length === 0) return sizes.reduce((best, size) => (size.width * size.height < best.width * best.height ? size : best));
  return fitting.reduce((best, size) => (size.width * size.height > best.width * best.height ? size : best));
}

/** Telegram serves profile photos as JPEG; anything else in the body is not the photo. */
function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function createTelegramAvatarSource(adapter: TelegramAvatarSourceAdapter): TelegramAvatarSource {
  return {
    async download(photo) {
      const bytes = await adapter.download({
        fileId: photo.fileId,
        fileUniqueId: photo.fileUniqueId,
        height: photo.height,
        kind: "photo",
        mediaType: "image/jpeg",
        ...(photo.size === undefined ? {} : { size: photo.size }),
        width: photo.width,
      });
      if (!isJpeg(bytes)) {
        throw new AppError("AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID", "Telegram отдал не JPEG вместо фото профиля");
      }
      return bytes;
    },
    async lookup(telegramUserId) {
      const body = await adapter.profilePhotos(telegramUserId);
      const parsed = profilePhotosSchema.safeParse(body);
      if (!parsed.success) {
        throw new AppError(
          "AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID",
          "Telegram вернул неожиданный ответ о фото профиля",
        );
      }
      const first = parsed.data.result.photos[0];
      if (first === undefined || first.length === 0) return { status: "none" };
      const photo = pickAvatarSize(first.map((size) => ({
        fileId: size.file_id,
        fileUniqueId: size.file_unique_id,
        height: size.height,
        ...(size.file_size === undefined ? {} : { size: size.file_size }),
        width: size.width,
      })));
      return { photo, status: "photo" };
    },
  };
}

export const telegramAvatarSource = createTelegramAvatarSource({
  download: createTelegramAttachmentDownloader({
    downloadFile: (filePath) => downloadTelegramFile({ filePath }),
    getFile: (fileId) => getTelegramFile({ fileId }),
  }),
  async profilePhotos(telegramUserId) {
    const response = await callTelegramApi({
      body: { limit: 1, user_id: Number(telegramUserId) },
      method: "getUserProfilePhotos",
    });
    // «Bad Request: user not found» for a person who posts in the group (two of eight Ft86
    // participants, 16 октября 2026): to the bot such a person has no visible photo either.
    const rawDescription = typeof response.body === "object" && response.body !== null && "description" in response.body
      ? (response.body as { description?: unknown }).description
      : undefined;
    const description = typeof rawDescription === "string" ? rawDescription : "";
    if (response.status === 400 && /user not found/iu.test(description)) return { ok: true, result: { photos: [], total_count: 0 } };
    if (!response.ok) {
      throw new AppError("AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED", `Telegram ответил HTTP ${response.status}`);
    }
    return response.body;
  },
});
