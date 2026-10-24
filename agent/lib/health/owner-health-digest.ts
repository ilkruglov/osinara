/**
 * Daily health digest for the family owner.
 *
 * Exports:
 * - `formatOwnerHealthDigest`: one plain-text Telegram message from the report.
 * - `createOwnerHealthDigestDispatcher` / `dispatchOwnerHealthDigests`: send once per day per owner.
 *
 * Key constructs:
 * - Three incidents in one week were found by people, not by the agent: a member's private chat
 *   silent for a night, a group session poisoned for two hours, a review lane stuck for three days
 *   with 1 400 unreviewed messages. The signals existed in tables; nobody read them. The digest
 *   reads them every morning and says so even when everything is fine, so silence means the
 *   dispatcher itself is down.
 * - The schedule ticks every ten minutes; the dispatcher sends after the digest hour and takes a
 *   durable claim first, so a restart neither skips a day nor sends it twice.
 * - The DeepSeek balance and the disk headroom (26 сентября 2026, after homka): a spent balance or
 *   a disk too full for an update is a failure line at the top; a healthy balance with the day's
 *   spend (the difference to yesterday's digest) is information next to the memory counts.
 * - Failed scheduled scenarios (5 октября 2026, after upstream #307): a failed run sends nothing
 *   to anyone, so the digest is the only place the owner learns a scenario did not arrive.
 * - Turn quality (10 октября 2026): every interactive turn is evaluated without a model; the line
 *   is information on a normal day and a failure line when failed turns, loops or corrections
 *   cross their thresholds, so a bad release is seen the next morning, not found by people.
 * - Telegram's webhook view (24 октября 2026, after Шуша): updates piling up or a fresh delivery
 *   error are a failure line (`telegram-webhook-health.ts`), read once per pass; a failed check is
 *   the line «не удалось проверить вебхук». A deaf webhook looks from inside like a quiet day.
 * - An owner chat Telegram calls unreachable (bot blocked, account deleted) keeps today's claim
 *   instead of releasing it: the next ten-minute tick would only skip again. `claim` takes back an
 *   unsent claim after an hour, so the digest is tried hourly and arrives once the owner writes again.
 */
import { DEEPSEEK_BALANCE_ALERT_USD } from "../../config.js";
import { type DeepSeekBalance, formatDeepSeekBalance, readConfiguredDeepSeekBalance } from "./deepseek-balance.js";
import { formatStorageHeadroom, readStorageHeadroom, type StorageHeadroom } from "./storage-headroom.js";
import {
  memoryReviewOwnerAlertTransport,
  TelegramRecipientUnreachableError,
} from "../memory-review/memory-review-owner-alert-transport.js";
import { formatTelegramWebhookHealth, readTelegramWebhookHealth, type TelegramWebhookHealth } from "./telegram-webhook-health.js";
import {
  type OwnerHealthRecipient,
  type OwnerHealthReport,
  ownerHealthDigestRepository,
} from "./owner-health-digest-repository.js";
import { formatScheduleRunFailures } from "./schedule-run-failures.js";
import { formatTurnQuality } from "./turn-quality-digest.js";

const OWNER_HEALTH_DIGEST_HOUR_UTC = 6;
const OWNER_HEALTH_DIGEST_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;

const MOSCOW = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", hour: "2-digit", minute: "2-digit", month: "long", timeZone: "Europe/Moscow",
});

function when(date: Date): string {
  return MOSCOW.format(date);
}

export interface OwnerHealthExtras {
  balance: DeepSeekBalance | null;
  previousBalanceUsd: number | null;
  storage: StorageHeadroom | null;
  /** Telegram's view of the webhook; absent or null means no line. */
  webhook?: TelegramWebhookHealth | null;
}

const NO_EXTRAS: OwnerHealthExtras = { balance: null, previousBalanceUsd: null, storage: null };

export function formatOwnerHealthDigest(report: OwnerHealthReport, extras: OwnerHealthExtras = NO_EXTRAS): string {
  const lines: string[] = [];
  // A spent balance means the bot is not answering: a failure, not information.
  const change = extras.balance !== null && extras.previousBalanceUsd !== null ? extras.balance.totalUsd - extras.previousBalanceUsd : null;
  const balance = formatDeepSeekBalance(extras.balance, DEEPSEEK_BALANCE_ALERT_USD, change);
  if (balance?.warning) lines.push(balance.text);
  if (report.rotations.count > 0) {
    lines.push(`Сессии: ${report.rotations.count} ротаций после сбоя` +
      (report.rotations.latestAt ? `, последняя ${when(report.rotations.latestAt)}` : "") + ".");
  }
  // Telegram, not the agent, knows that updates stopped arriving: a deaf webhook looks like a quiet day.
  const windowEnd = new Date(report.windowStart.getTime() + OWNER_HEALTH_DIGEST_WINDOW_MILLISECONDS);
  const webhook = formatTelegramWebhookHealth(extras.webhook ?? null, windowEnd);
  if (webhook !== null) lines.push(webhook);
  if (report.ingressFailures.count > 0) {
    const codes = report.ingressFailures.codes.map((entry) => `${entry.code} ×${entry.count}`).join(", ");
    lines.push(`Очередь Telegram: ${report.ingressFailures.count} сбоев (${codes}).`);
  }
  for (const lane of report.lanes.blocked) {
    lines.push(`Проверка памяти «${lane.label}» стоит: голова ${lane.headStatus}` +
      (lane.code ? ` (${lane.code})` : "") + `, ждут ${lane.waiting} сообщений.`);
  }
  for (const lane of report.lanes.lagging) {
    lines.push(`Проверка памяти «${lane.label}» отстаёт: ${lane.waiting} сообщений с ${when(lane.oldestAt)}.`);
  }
  if (report.reviewBatches.failed > 0 || report.reviewBatches.ambiguous > 0) {
    lines.push(`Пакеты проверки: failed ${report.reviewBatches.failed}, ambiguous ${report.reviewBatches.ambiguous}.`);
  }
  if (report.alertDeliveryFailures > 0) {
    lines.push(`Не доставлено предупреждений владельцу: ${report.alertDeliveryFailures}.`);
  }
  const schedules = formatScheduleRunFailures(report.scheduleFailures);
  if (schedules !== null) lines.push(schedules);
  // Disk space is not a failure of the day but the condition under which the next update passes.
  const storage = extras.storage === null ? null : formatStorageHeadroom(extras.storage);
  if (storage !== null) lines.push(storage);
  const quality = formatTurnQuality(report.turnQuality);
  if (quality.warning) lines.push(quality.text);
  const written = report.memoryWritten.reduce((sum, entry) => sum + entry.count, 0);
  const breakdown = report.memoryWritten.map((entry) => `${entry.scope} ${entry.kind} ${entry.count}`).join(", ");
  const memory = written === 0 ? "Память: новых записей нет." : `Память: +${written} (${breakdown}).`;
  const header = lines.length === 0 ? "Сводка за сутки: сбоев нет." : "Сводка за сутки.";
  const information = [
    ...(balance !== null && !balance.warning ? [balance.text] : []),
    ...(quality.warning ? [] : [quality.text]),
  ];
  return [header, ...lines, ...information, memory].join("\n");
}

interface OwnerHealthDigestDependencies {
  /** The model account balance, read once per pass; null when not DeepSeek or unreadable. */
  balance(): Promise<DeepSeekBalance | null>;
  claim(familyId: string, digestDate: string, now: Date): Promise<boolean>;
  complete(familyId: string, digestDate: string, now: Date, textLength: number, balanceUsd: number | null): Promise<void>;
  deliver(input: { chatId: string; text: string }): Promise<void>;
  previousBalance(familyId: string, digestDate: string): Promise<number | null>;
  recipients(): Promise<OwnerHealthRecipient[]>;
  release(familyId: string, digestDate: string): Promise<void>;
  report(familyId: string, windowStart: Date, now: Date): Promise<OwnerHealthReport>;
  storage(): Promise<StorageHeadroom | null>;
  /** Telegram's view of the webhook, read once per pass; without the dependency there is no line. */
  webhook?(): Promise<TelegramWebhookHealth>;
}

/** The digest day is the UTC date once the digest hour has passed; before it there is nothing to send. */
export function digestDateFor(now: Date): string | null {
  if (now.getUTCHours() < OWNER_HEALTH_DIGEST_HOUR_UTC) return null;
  return now.toISOString().slice(0, 10);
}

export function createOwnerHealthDigestDispatcher(dependencies: OwnerHealthDigestDependencies) {
  return async function dispatchOwnerHealthDigests(now = new Date()): Promise<number> {
    const digestDate = digestDateFor(now);
    if (digestDate === null) return 0;
    let sent = 0;
    let shared: Promise<[DeepSeekBalance | null, StorageHeadroom | null, TelegramWebhookHealth | null]> | undefined;
    for (const recipient of await dependencies.recipients()) {
      if (!await dependencies.claim(recipient.familyId, digestDate, now)) continue;
      try {
        const report = await dependencies.report(
          recipient.familyId,
          new Date(now.getTime() - OWNER_HEALTH_DIGEST_WINDOW_MILLISECONDS),
          now,
        );
        // One balance, disk and webhook reading per pass: they belong to the installation, not the family.
        shared ??= Promise.all([dependencies.balance(), dependencies.storage(), dependencies.webhook?.() ?? null]);
        const [balance, storage, webhook] = await shared;
        const previousBalanceUsd = balance === null ? null : await dependencies.previousBalance(recipient.familyId, digestDate);
        const text = formatOwnerHealthDigest(report, { balance, previousBalanceUsd, storage, webhook });
        await dependencies.deliver({ chatId: recipient.ownerTelegramUserId, text });
        await dependencies.complete(recipient.familyId, digestDate, now, text.length, balance?.totalUsd ?? null);
        console.info(JSON.stringify({
          code: "AGENT_OWNER_HEALTH_DIGEST_SENT",
          blockedLanes: report.lanes.blocked.length,
          familyId: recipient.familyId,
          ingressFailures: report.ingressFailures.count,
          rotations: report.rotations.count,
          scheduleFailures: report.scheduleFailures.count,
        }));
        sent += 1;
      } catch (error) {
        // The claim goes back so the next tick retries; a lost digest is exactly the silence it exists to end.
        // An unreachable owner chat keeps it: `claim` retakes it after an hour, the tick would only skip.
        const unreachable = error instanceof TelegramRecipientUnreachableError;
        if (!unreachable) await dependencies.release(recipient.familyId, digestDate);
        console.error(JSON.stringify({
          code: unreachable ? error.code : "AGENT_OWNER_HEALTH_DIGEST_FAILED",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}

export function dispatchOwnerHealthDigests(now = new Date()): Promise<number> {
  return createOwnerHealthDigestDispatcher({
    balance: readConfiguredDeepSeekBalance,
    claim: (familyId, digestDate, at) => ownerHealthDigestRepository.claim(familyId, digestDate, at),
    complete: (familyId, digestDate, at, length, balanceUsd) => ownerHealthDigestRepository.complete(familyId, digestDate, at, length, balanceUsd),
    deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
    previousBalance: (familyId, digestDate) => ownerHealthDigestRepository.previousBalance(familyId, digestDate),
    recipients: () => ownerHealthDigestRepository.recipients(),
    release: (familyId, digestDate) => ownerHealthDigestRepository.release(familyId, digestDate),
    report: (familyId, windowStart, at) => ownerHealthDigestRepository.report(familyId, windowStart, at),
    storage: () => readStorageHeadroom(() => ownerHealthDigestRepository.databaseBytes()),
    webhook: () => readTelegramWebhookHealth({ botToken: process.env.TELEGRAM_BOT_TOKEN }),
  })(now);
}
