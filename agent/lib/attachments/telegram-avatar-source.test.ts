/**
 * Telegram avatar source tests.
 *
 * Constructs covered:
 * - The size picked is the largest at or under 640 px, or the smallest when every size is larger;
 *   a download that is not a JPEG is refused.
 * - A lookup returns the photo of the newest profile picture, "none" for an empty list, and a
 *   stable error for a body Telegram did not promise.
 * - A download passes the chosen file to the attachment downloader as a photo.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramAvatarSource, pickAvatarSize } from "./telegram-avatar-source.js";

const sizes = [
  { file_id: "s", file_size: 1_000, file_unique_id: "u1", height: 160, width: 160 },
  { file_id: "m", file_size: 4_000, file_unique_id: "u1", height: 320, width: 320 },
  { file_id: "l", file_size: 12_000, file_unique_id: "u1", height: 640, width: 640 },
  { file_id: "xl", file_size: 40_000, file_unique_id: "u1", height: 1280, width: 1280 },
];

describe("pickAvatarSize", () => {
  it("prefers the largest size that still fits a reference, else the smallest offered", () => {
    const photos = sizes.map((size) => ({ fileId: size.file_id, fileUniqueId: size.file_unique_id, height: size.height, size: size.file_size, width: size.width }));
    expect(pickAvatarSize(photos).fileId).toBe("l");
    const big = { fileId: "huge", fileUniqueId: "u1", height: 1600, size: 90_000, width: 1600 };
    expect(pickAvatarSize([photos[3]!, big]).fileId).toBe("xl");
  });
});

describe("createTelegramAvatarSource", () => {
  it("looks up the newest profile photo and downloads the chosen size", async () => {
    const download = vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]));
    const source = createTelegramAvatarSource({
      download,
      profilePhotos: vi.fn().mockResolvedValue({ ok: true, result: { photos: [sizes, sizes.slice(0, 1)], total_count: 2 } }),
    });
    const lookup = await source.lookup("151894754");
    expect(lookup).toEqual({ photo: { fileId: "l", fileUniqueId: "u1", height: 640, size: 12_000, width: 640 }, status: "photo" });
    if (lookup.status !== "photo") throw new Error("expected a photo");
    await expect(source.download(lookup.photo)).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]));
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ fileId: "l", kind: "photo", mediaType: "image/jpeg", size: 12_000 }));
  });

  it("refuses a download that is not a JPEG", async () => {
    const source = createTelegramAvatarSource({ download: vi.fn().mockResolvedValue(Buffer.from("<html>")), profilePhotos: vi.fn() });
    await expect(source.download({ fileId: "f", fileUniqueId: "u", height: 1, width: 1 })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID" });
  });

  it("reports no photo for an empty list and refuses a body Telegram never promised", async () => {
    const none = createTelegramAvatarSource({ download: vi.fn(), profilePhotos: vi.fn().mockResolvedValue({ ok: true, result: { photos: [], total_count: 0 } }) });
    await expect(none.lookup("1")).resolves.toEqual({ status: "none" });
    const odd = createTelegramAvatarSource({ download: vi.fn(), profilePhotos: vi.fn().mockResolvedValue({ ok: true, result: "surprise" }) });
    await expect(odd.lookup("1")).rejects.toMatchObject({ code: "AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID" });
  });
});
