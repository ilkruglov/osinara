/**
 * Telegram widget cards of the health journal, built from computed summaries.
 *
 * Exports:
 * - `renderDayCard`: the day card — a ring with calories left (or the evening balance), macros,
 *   fiber and water against targets, meals, and sleep and load folded under them.
 * - `renderWeekCard`: calories by day against the target, the weight trend, sleep, load and the
 *   weekly check's sentence.
 * - `checkSentence`: the weekly check in one sentence, with the check's own thresholds.
 * - `num`, `signed`, `duration`: Russian number, signed number and duration formats.
 *
 * Key constructs:
 * - The design was chosen by the owner on 11 November 2026 (variant A: one accent colour, no red
 *   «too much» tags, the theme's own text and background colours); see the skill `telegram-widgets`
 *   for what a card may contain.
 * - Every text from the journal is HTML-escaped: a meal title is the person's words, not markup.
 * - Size: at most `MEAL_ROWS` meal rows are shown, the rest fold into one «ещё» row, so a busy day
 *   stays under the 600 px bubble and the 4 KB compressed limit (checked in tests).
 */
import {
  CHECK_WINDOW_DAYS,
  MAX_DESCRIBED_SHARE,
  MIN_LOGGED_DAYS,
  MIN_WEIGH_IN_SPAN_DAYS,
  MIN_WEIGH_INS,
} from "./expenditure-check.js";
import type { DaySummary, WeekSummary } from "./health-summary-data.js";

const MEAL_ROWS = 7;

const BASE_STYLE = `.w{--a:#2e9b57;--tx:var(--tg-theme-text-color,#111);--hn:var(--tg-theme-hint-color,#8a8f98);--sb:var(--tg-theme-secondary-bg-color,#eef0f2);--ln:var(--tg-theme-section-separator-color,#e6e7ea);font:14px/1.35 system-ui,sans-serif;color:var(--tx);padding:14px 16px 12px}
.k{display:flex;justify-content:space-between;font-size:12px;color:var(--hn);white-space:nowrap}
.h2{display:flex;justify-content:space-between;font-size:11px;font-weight:600;color:var(--hn);letter-spacing:.04em;text-transform:uppercase;margin:16px 0 4px;white-space:nowrap}
.h2 b{color:var(--tx);font-size:13px;letter-spacing:0;text-transform:none}
.row{display:flex;align-items:baseline;gap:10px;padding:6px 0;border-top:1px solid var(--ln);white-space:nowrap}
.row .m{flex:none;min-width:36px;color:var(--hn);font-size:12px;font-variant-numeric:tabular-nums}
.row .x{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.row .v{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
.ft{color:var(--hn);font-size:11px;margin-top:10px}
.bar{height:4px;border-radius:2px;background:var(--sb);overflow:hidden}
.bar i{display:block;height:100%;border-radius:2px;background:var(--a)}
svg{display:block}
details{margin-top:10px;border-top:1px solid var(--ln);padding-top:6px}
summary{font-size:12px;color:var(--hn);white-space:nowrap}
`;

const DAY_STYLE = `.top{display:flex;align-items:center;gap:16px;margin-top:10px}
.rg{flex:none;position:relative;width:118px;height:118px}
.rg .c{position:absolute;left:0;right:0;top:34px;text-align:center;white-space:nowrap}
.rg b{display:block;font-size:30px;line-height:1.05;letter-spacing:-.02em}.rg small{font-size:11px;color:var(--hn)}
.ms{flex:1;min-width:0}.mr{margin-bottom:6px;white-space:nowrap}.mr:last-child{margin:0}
.mr div:first-child{display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px}
.mr span{color:var(--hn)}.mr b{font-variant-numeric:tabular-nums}.mr b small{font-weight:400;color:var(--hn)}
.s{font-size:12px;color:var(--hn);margin-top:8px;white-space:nowrap}
`;

const WEEK_STYLE = `.big{font-size:40px;font-weight:700;line-height:1.05;letter-spacing:-.02em;margin-top:6px;white-space:nowrap}
.big small{font-size:14px;font-weight:500;color:var(--hn);letter-spacing:0;margin-left:6px}
.s{font-size:12px;color:var(--hn);margin-top:2px;white-space:nowrap}
.ch{width:100%;height:auto}.ch text{font:10px system-ui,sans-serif;fill:var(--hn)}
.kp{display:flex;gap:10px;margin-top:12px;padding-top:10px;border-top:1px solid var(--ln)}
.kc{flex:1;min-width:0;white-space:nowrap}
.kc .l{font-size:11px;color:var(--hn)}.kc .n{font-size:15px;font-weight:600;margin-top:1px}
.kc .n small{font-size:11px;font-weight:400;color:var(--hn)}
`;

const READY = "<script>if (window.TelegramWidget) TelegramWidget.ready();</script>";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const num = (value: number, digits = 0) =>
  value.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** A minus sign, not a hyphen; zero has no sign. */
export const signed = (value: number, digits = 0) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${num(Math.abs(value), digits)}`;

function dateLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** «3–9 ноября» within a month, «27 октября – 2 ноября» across two. */
function period(from: string, to: string): string {
  const long = (date: string) => dateLabel(date, { day: "numeric", month: "long" });
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${Number(from.slice(8))}–${long(to)}`
    : `${long(from)} – ${long(to)}`;
}

function weekday(date: string): string {
  const label = dateLabel(date, { weekday: "short" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} мин` : `${hours} ч ${String(rest).padStart(2, "0")} мин`;
}

function share(value: number, target: number | null): number {
  if (target === null || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
}

function ring(fraction: number): string {
  const size = 118;
  const center = size / 2;
  const radius = 51;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, fraction)) * circumference;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--sb)" stroke-width="10"/>` +
    (filled > 0
      ? `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--a)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 ${center} ${center})"/>`
      : "") +
    "</svg>"
  );
}

function macroRow(
  label: string,
  value: number,
  target: number | null,
  unit: string,
  digits = 0,
): string {
  const goal =
    target === null ? `<small> ${unit}</small>` : `<small> / ${num(target, digits)}</small>`;
  return (
    `<div class="mr"><div><span>${label}</span><b>${num(value, digits)}${goal}</b></div>` +
    `<div class="bar"><i style="width:${share(value, target)}%"></i></div></div>`
  );
}

function ringCenter(
  day: DaySummary,
  view: "evening" | "progress",
): { fraction: number; label: string; value: string } {
  const eaten = day.eaten.kcal;
  if (view === "evening" && day.balanceKcal !== null && day.expenditure !== null)
    return {
      fraction: eaten / day.expenditure.totalKcal,
      label: "баланс, ккал",
      value: signed(day.balanceKcal),
    };
  if (day.remainingKcal === null || day.targets.kcal === null)
    return { fraction: 0, label: "ккал съедено", value: num(eaten) };
  return day.remainingKcal >= 0
    ? { fraction: eaten / day.targets.kcal, label: "ккал осталось", value: num(day.remainingKcal) }
    : { fraction: 1, label: "ккал сверх цели", value: `+${num(-day.remainingKcal)}` };
}

function loadLines(day: DaySummary): string[] {
  const lines: string[] = [];
  if (day.sleep !== null) {
    const window =
      day.sleep.bedtime !== null && day.sleep.wakeTime !== null
        ? `${day.sleep.bedtime} → ${day.sleep.wakeTime}`
        : "";
    lines.push(
      `<div class="row"><span class="x">Сон</span><span class="m">${window}</span><span class="v">${duration(day.sleep.totalMin)}</span></div>`,
    );
  }
  if (day.activity?.steps != null) {
    const distance =
      day.activity.distanceM === null ? "" : `${num(day.activity.distanceM / 1000, 1)} км`;
    lines.push(
      `<div class="row"><span class="x">Шаги</span><span class="m">${distance}</span><span class="v">${num(day.activity.steps)}</span></div>`,
    );
  }
  if (day.activity?.restingHr != null)
    lines.push(
      `<div class="row"><span class="x">Пульс покоя</span><span class="v">${day.activity.restingHr}</span></div>`,
    );
  for (const workout of day.workouts) {
    const load = workout.tonnageKg > 0 ? `${num(workout.tonnageKg / 1000, 1)} т` : "";
    lines.push(
      `<div class="row"><span class="x">${escapeHtml(workout.title)}</span><span class="m">${load}</span><span class="v">${duration(workout.durationMin)}</span></div>`,
    );
  }
  if (day.expenditure !== null)
    lines.push(
      `<div class="row"><span class="x">Расход за день</span><span class="m">база ${num(day.expenditure.baseKcal)}</span><span class="v">≈ ${num(day.expenditure.totalKcal)}</span></div>`,
    );
  return lines;
}

export function renderDayCard(day: DaySummary, view: "evening" | "progress"): string {
  const center = ringCenter(day, view);
  const t = day.targets;
  const macros =
    macroRow("Белки", day.eaten.protein, t.proteinG, "г") +
    macroRow("Жиры", day.eaten.fat, t.fatG, "г") +
    macroRow("Углеводы", day.eaten.carbs, t.carbsG, "г") +
    macroRow("Клетчатка", day.eaten.fiber, t.fiberG, "г") +
    macroRow(
      "Вода, л",
      day.eaten.waterMl / 1000,
      t.waterMl === null ? null : t.waterMl / 1000,
      "л",
      1,
    );
  const shown = day.meals.slice(0, day.meals.length > MEAL_ROWS ? MEAL_ROWS - 1 : MEAL_ROWS);
  const hidden = day.meals.slice(shown.length);
  const meals = shown
    .map(
      (meal) =>
        `<div class="row"><span class="m">${meal.time}</span><span class="x">${escapeHtml(meal.title)}</span><span class="v">${meal.approximate ? "≈ " : ""}${num(meal.kcal)}</span></div>`,
    )
    .join("");
  const more =
    hidden.length === 0
      ? ""
      : `<div class="row"><span class="m"></span><span class="x">ещё ${hidden.length}</span><span class="v">${num(hidden.reduce((sum, meal) => sum + meal.kcal, 0))}</span></div>`;
  const summaryLine =
    view === "evening" && day.expenditure !== null
      ? `<div class="s">съедено ${num(day.eaten.kcal)}${t.kcal === null ? "" : ` из ${num(t.kcal)}`} · расход ≈ ${num(day.expenditure.totalKcal)}</div>`
      : "";
  const load = loadLines(day);
  const notes: string[] = [];
  if (day.meals.some((meal) => meal.approximate)) notes.push("≈ — оценка по фото или со слов");
  if (t.source === "none") notes.push("цель не задана: нужен профиль");
  const heading = day.isToday ? (view === "evening" ? "Итог дня" : "Сегодня") : "День";
  return [
    `<style>${BASE_STYLE}${DAY_STYLE}</style>`,
    `<div class="w"><div class="k"><span>${heading}</span><span>${dateLabel(day.date, { day: "numeric", month: "long", weekday: "short" })}</span></div>`,
    `<div class="top"><div class="rg">${ring(center.fraction)}<div class="c"><b>${center.value}</b><small>${center.label}</small></div></div><div class="ms">${macros}</div></div>`,
    summaryLine,
    day.meals.length === 0 ? "" : `<div class="h2"><span>Еда и напитки</span></div>${meals}${more}`,
    load.length === 0 ? "" : `<details><summary>Сон и нагрузка</summary>${load.join("")}</details>`,
    notes.length === 0 ? "" : `<div class="ft">${notes.join(" · ")}</div>`,
    `</div>${READY}`,
  ].join("\n");
}

function caloriesChart(week: WeekSummary): string {
  const width = 268;
  const base = 80;
  const top = 8;
  const values = week.days.flatMap((day) => [day.eatenKcal ?? 0, day.targetKcal ?? 0]);
  const scale = Math.max(...values, 1) * 1.1;
  const y = (value: number) => base - ((base - top) * value) / scale;
  const step = width / 7;
  const bars = week.days
    .map((day, index) => {
      if (day.eatenKcal === null || day.eatenKcal <= 0) return "";
      const x = index * step + step / 2 - 6;
      const height = Math.max(base - y(day.eatenKcal), 4);
      return `<rect x="${x.toFixed(1)}" y="${(base - height).toFixed(1)}" width="12" height="${height.toFixed(1)}" rx="4"/>`;
    })
    .join("");
  const target = week.targets.kcal;
  const line =
    target === null
      ? ""
      : `<line x1="0" y1="${y(target).toFixed(1)}" x2="${width}" y2="${y(target).toFixed(1)}" stroke="var(--tx)" stroke-width="1" stroke-dasharray="3 3" opacity=".45"/><text x="0" y="${(y(target) - 4).toFixed(1)}">цель ${num(target)}</text>`;
  const labels = week.days
    .map(
      (day, index) =>
        `<text x="${(index * step + step / 2).toFixed(1)}" y="93">${weekday(day.date)}</text>`,
    )
    .join("");
  return `<svg class="ch" viewBox="0 0 ${width} 96"><g fill="var(--a)">${bars}</g>${line}<g text-anchor="middle">${labels}</g></svg>`;
}

function weightChart(week: WeekSummary): string {
  const points = week.weight.points;
  if (points.length < 2) return `<div class="s">мало взвешиваний для графика</div>`;
  const width = 268;
  const values = points.flatMap((point) => [point.weightKg, point.trendKg]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, 0.4);
  const firstTime = Date.parse(`${points[0]!.date}T00:00:00Z`);
  const lastTime = Date.parse(`${points.at(-1)!.date}T00:00:00Z`);
  const x = (date: string) =>
    6 +
    ((width - 12) * (Date.parse(`${date}T00:00:00Z`) - firstTime)) /
      Math.max(lastTime - firstTime, 1);
  const y = (value: number) => 6 + (36 * (high - value)) / span;
  const dots = points
    .map(
      (point) =>
        `<circle cx="${x(point.date).toFixed(1)}" cy="${y(point.weightKg).toFixed(1)}" r="2.5"/>`,
    )
    .join("");
  const trend = points
    .map((point) => `${x(point.date).toFixed(1)},${y(point.trendKg).toFixed(1)}`)
    .join(" ");
  const last = points.at(-1)!;
  return (
    `<svg class="ch" viewBox="0 0 ${width} 62"><g fill="var(--hn)" opacity=".45">${dots}</g>` +
    `<polyline points="${trend}" fill="none" stroke="var(--a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${x(last.date).toFixed(1)}" cy="${y(last.trendKg).toFixed(1)}" r="4" fill="var(--a)" stroke="var(--tg-theme-bg-color,#fff)" stroke-width="2"/>` +
    `<text x="6" y="60">${dateLabel(points[0]!.date, { day: "numeric", month: "short" })}</text>` +
    `<text x="${width - 6}" y="60" text-anchor="end">сглаженный ${num(last.trendKg, 1)}</text></svg>`
  );
}

/** The window is whole weeks (3); «недели» fits 2–4 of them. */
const WINDOW_WEEKS = CHECK_WINDOW_DAYS / 7;

export function checkSentence(week: WeekSummary): string {
  const check = week.check;
  if (check.status === "insufficient") {
    const need = {
      approximate: `больше ${Math.round(MAX_DESCRIBED_SHARE * 100)} % калорий записано со слов без граммов, а такие оценки систематически завышены`,
      logged_days: `записей еды ${check.loggedDays} дней из ${MIN_LOGGED_DAYS} нужных за ${WINDOW_WEEKS} недели`,
      profile: "нужен профиль: пол, дата рождения, рост, активность",
      weigh_ins: `взвешиваний ${check.weighIns} из ${MIN_WEIGH_INS} нужных за ${WINDOW_WEEKS} недели`,
      weigh_in_span: `взвешивания должны охватывать хотя бы ${MIN_WEIGH_IN_SPAN_DAYS} дней`,
    }[check.reason];
    return `Сверка расхода с весом пока невозможна: ${need}.`;
  }
  const gap = check.observedKcal - check.formulaKcal;
  if (check.proposedAdjustmentKcal === null)
    return `Расход по динамике веса ≈ ${num(check.observedKcal)} ккал, формула сходится.`;
  return `Расход по динамике веса ≈ ${num(check.observedKcal)} ккал, на ${num(Math.abs(gap))} ${gap > 0 ? "выше" : "ниже"} формулы: можно поправить цель.`;
}

export function renderWeekCard(week: WeekSummary): string {
  const avg = week.averages;
  const target = week.targets.kcal;
  const status =
    target === null
      ? `записано ${week.loggedDays} дней из 7`
      : `цель ${num(target)} · в норме ${week.onTargetDays} из ${week.loggedDays}`;
  const weightHeading =
    week.weight.trendKg === null
      ? ""
      : `<b>${num(week.weight.trendKg, 1)} кг${week.weight.changeKg === null ? "" : ` · ${signed(week.weight.changeKg, 1)} за неделю`}</b>`;
  const tile = (label: string, value: string, unit: string) =>
    `<div class="kc"><div class="l">${label}</div><div class="n">${value}${unit === "" ? "" : `<small> ${unit}</small>`}</div></div>`;
  const ofTarget = (value: number | null, goal: number | null) =>
    value === null ? "—" : `${num(value)}${goal === null ? "" : `<small> / ${num(goal)}</small>`}`;
  return [
    `<style>${BASE_STYLE}${WEEK_STYLE}</style>`,
    `<div class="w"><div class="k"><span>Неделя</span><span>${period(week.from, week.to)}</span></div>`,
    `<div class="big">${avg.kcal === null ? "—" : num(avg.kcal)}<small>ккал в день</small></div><div class="s">${status}</div>`,
    `<div class="h2"><span>Калории</span></div>${caloriesChart(week)}`,
    `<div class="h2"><span>Вес</span>${weightHeading}</div>${weightChart(week)}`,
    `<div class="kp">${tile("Белок", ofTarget(avg.proteinG, week.targets.proteinG), "г")}${tile("Клетчатка", ofTarget(avg.fiberG, week.targets.fiberG), "г")}${tile("Расход", avg.expenditureKcal === null ? "—" : num(avg.expenditureKcal), "ккал")}</div>`,
    `<div class="kp">${tile("Сон", avg.sleepMin === null ? "—" : duration(avg.sleepMin), "")}${tile("Шаги", avg.steps === null ? "—" : num(avg.steps), "в день")}${tile("Тренировки", String(week.workouts.count), week.workouts.minutes === 0 ? "" : duration(week.workouts.minutes))}</div>`,
    `<div class="ft">${escapeHtml(checkSentence(week))}</div>`,
    `</div>${READY}`,
  ].join("\n");
}
