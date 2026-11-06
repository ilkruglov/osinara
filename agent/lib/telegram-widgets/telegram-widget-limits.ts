/**
 * Size limits of a Telegram widget message (Bot API 10.4 beta, widget format of layer 233).
 *
 * Exports:
 * - `TELEGRAM_WIDGET_MAX_BYTES`, `TELEGRAM_WIDGET_MAX_COMPRESSED_BYTES`: Telegram's two limits.
 * - `measureTelegramWidget`: UTF-8 bytes of the HTML and of its zlib stream at level 9.
 * - `requireTelegramWidgetSize`: the measurement, or a refusal naming both sizes.
 *
 * Key construct:
 * - Telegram compresses the HTML itself with zlib level 9 and refuses a widget over 32 KB raw or
 *   4 KB compressed (`INPUT_MEDIA_WIDGET_TOO_LARGE`). Measuring the same way here turns that into a
 *   refusal before any request, with numbers the author can act on.
 */
import { deflateSync } from "node:zlib";

import { AppError } from "../app-error.js";

export const TELEGRAM_WIDGET_MAX_BYTES = 32 * 1024;
export const TELEGRAM_WIDGET_MAX_COMPRESSED_BYTES = 4 * 1024;

export interface TelegramWidgetSize {
  bytes: number;
  compressedBytes: number;
}

export function measureTelegramWidget(html: string): TelegramWidgetSize {
  const raw = Buffer.from(html, "utf8");
  return { bytes: raw.byteLength, compressedBytes: deflateSync(raw, { level: 9 }).byteLength };
}

export function requireTelegramWidgetSize(html: string): TelegramWidgetSize {
  const size = measureTelegramWidget(html);
  if (size.bytes > TELEGRAM_WIDGET_MAX_BYTES || size.compressedBytes > TELEGRAM_WIDGET_MAX_COMPRESSED_BYTES) {
    throw new AppError(
      "AGENT_TELEGRAM_WIDGET_TOO_LARGE",
      `Виджет ${size.bytes} байт, после сжатия ${size.compressedBytes}; Telegram принимает до ${TELEGRAM_WIDGET_MAX_BYTES} и до ${TELEGRAM_WIDGET_MAX_COMPRESSED_BYTES} после сжатия`,
    );
  }
  return size;
}
