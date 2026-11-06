/**
 * The owner's morning digest drawn as a Telegram widget card.
 *
 * Export:
 * - `ownerHealthDigestWidget`: the card and its caption from the digest's sections.
 *
 * Key constructs:
 * - The card says the same as the text digest, from the same sections: a status chip, the failures
 *   first in red, then the information and the memory line. The caption is the verdict in one line
 *   («сбоев нет» or the count), so a preview and an older client still read the day.
 * - Static HTML, no script beyond `ready()`: nothing to break. Chat names and codes from the report
 *   are escaped; colours come from the chat's theme with fallbacks, the verdict colours are fixed.
 */
import type { OwnerHealthDigestSections } from "./owner-health-digest.js";

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });

const escape = (text: string): string =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

function failureWord(count: number): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return "сбоев";
  if (units === 1) return "сбой";
  if (units >= 2 && units <= 4) return "сбоя";
  return "сбоев";
}

export function ownerHealthDigestWidget(sections: OwnerHealthDigestSections, now: Date): { caption: string; html: string } {
  const failed = sections.failures.length;
  const verdict = failed === 0 ? "сбоев нет" : `${failed} ${failureWord(failed)}`;
  const rows = (lines: readonly string[], kind: string) => lines.map((line) => `<li class="${kind}">${escape(line)}</li>`).join("");
  const html = `<style>
.w{font:14px/1.4 system-ui,sans-serif;color:var(--tg-theme-text-color,#111);padding:10px 12px}
.h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.t{font-weight:600;font-size:16px}.d{color:var(--tg-theme-hint-color,#888);font-size:12px}
.c{display:inline-block;border-radius:10px;padding:2px 10px;font-weight:600;color:#fff;background:${failed === 0 ? "#2e9b57" : "#d64541"}}
ul{list-style:none;margin:0;padding:0}li{padding:5px 0;border-top:1px solid var(--tg-theme-section-separator-color,#ddd)}
li.f{color:#d64541}li.m{color:var(--tg-theme-hint-color,#888)}
</style>
<div class="w"><div class="h"><span class="t">Сводка Мии</span><span class="d">${escape(DATE.format(now))}</span></div>
<div class="c">${verdict}</div>
<ul>${rows(sections.failures, "f")}${rows(sections.information, "i")}${rows([sections.memory], "m")}</ul></div>
<script>if (window.TelegramWidget) TelegramWidget.ready();</script>`;
  return { caption: `Сводка за сутки: ${verdict}.`, html };
}
