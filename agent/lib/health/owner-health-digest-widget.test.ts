/**
 * The owner's morning digest as a Telegram widget card.
 *
 * Constructs covered:
 * - A quiet day: a green "сбоев нет" card and the same words as the caption.
 * - Failures lead the card, counted in the caption with Russian plural forms; names of chats and
 *   codes are escaped, so a chat called `<script>` stays text.
 * - The card passes the widget check with nothing to report and fits the 4 KB budget even on a
 *   heavy day.
 */
import { describe, expect, it } from "vitest";

import { measureTelegramWidget } from "../telegram-widgets/telegram-widget-limits.js";
import { lintTelegramWidget } from "../telegram-widgets/telegram-widget-lint.js";
import { ownerHealthDigestWidget } from "./owner-health-digest-widget.js";

const now = new Date("2026-11-06T06:10:00Z");
const quiet = { failures: [], header: "Сводка за сутки: сбоев нет.", information: ["DeepSeek: баланс 12,50 $, за сутки −1,20 $."], memory: "Память: +4 (group episode 3, personal profile 1)." };

describe("ownerHealthDigestWidget", () => {
  it("draws a quiet day as a green card with the same caption", () => {
    const widget = ownerHealthDigestWidget(quiet, now);
    expect(widget.caption).toBe("Сводка за сутки: сбоев нет.");
    expect(widget.html).toContain("сбоев нет");
    expect(widget.html).toContain("DeepSeek: баланс 12,50 $");
    expect(lintTelegramWidget(widget.html, { allowLinks: false })).toEqual({ errors: [], links: [], warnings: [] });
  });

  it("leads with the failures, counts them in Russian and escapes what came from chats", () => {
    for (const [count, word] of [[1, "сбой"], [3, "сбоя"], [5, "сбоев"], [11, "сбоев"], [21, "сбой"]] as const) {
      const failures = Array.from({ length: count }, (_, i) => `Проверка памяти «<script>чат ${i}</script>» стоит.`);
      const widget = ownerHealthDigestWidget({ ...quiet, failures, header: "Сводка за сутки." }, now);
      expect(widget.caption).toBe(`Сводка за сутки: ${count} ${word}.`);
      expect(widget.html).not.toContain("<script>чат");
      expect(widget.html).toContain("&lt;script&gt;чат 0");
    }
  });

  it("fits the 4 KB budget on a heavy day", () => {
    const failures = Array.from({ length: 14 }, (_, i) =>
      `Проверка памяти «Группа номер ${i} с длинным названием» отстаёт: ${100 + i * 7} сообщений с 5 ноября, 0${i % 10}:15.`);
    const widget = ownerHealthDigestWidget({ ...quiet, failures, header: "Сводка за сутки." }, now);
    expect(measureTelegramWidget(widget.html).compressedBytes).toBeLessThan(4_096);
  });
});
