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
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import {
  type OwnerHealthRecipient,
  type OwnerHealthReport,
  ownerHealthDigestRepository,
} from "./owner-health-digest-repository.js";

export const OWNER_HEALTH_DIGEST_HOUR_UTC = 6;
export const OWNER_HEALTH_DIGEST_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;

const MOSCOW = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", hour: "2-digit", minute: "2-digit", month: "long", timeZone: "Europe/Moscow",
});

function when(date: Date): string {
  return MOSCOW.format(date);
}

export function formatOwnerHealthDigest(report: OwnerHealthReport): string {
  const lines: string[] = [];
  if (report.rotations.count > 0) {
    lines.push(`Сессии: ${report.rotations.count} ротаций после сбоя` +
      (report.rotations.latestAt ? `, последняя ${when(report.rotations.latestAt)}` : "") + ".");
  }
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
  const written = report.memoryWritten.reduce((sum, entry) => sum + entry.count, 0);
  const breakdown = report.memoryWritten.map((entry) => `${entry.scope} ${entry.kind} ${entry.count}`).join(", ");
  const memory = written === 0 ? "Память: новых записей нет." : `Память: +${written} (${breakdown}).`;
  const header = lines.length === 0 ? "Сводка за сутки: сбоев нет." : "Сводка за сутки.";
  return [header, ...lines, memory].join("\n");
}

interface OwnerHealthDigestDependencies {
  claim(familyId: string, digestDate: string, now: Date): Promise<boolean>;
  complete(familyId: string, digestDate: string, now: Date, textLength: number): Promise<void>;
  deliver(input: { chatId: string; text: string }): Promise<void>;
  recipients(): Promise<OwnerHealthRecipient[]>;
  release(familyId: string, digestDate: string): Promise<void>;
  report(familyId: string, windowStart: Date, now: Date): Promise<OwnerHealthReport>;
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
    for (const recipient of await dependencies.recipients()) {
      if (!await dependencies.claim(recipient.familyId, digestDate, now)) continue;
      try {
        const report = await dependencies.report(
          recipient.familyId,
          new Date(now.getTime() - OWNER_HEALTH_DIGEST_WINDOW_MILLISECONDS),
          now,
        );
        const text = formatOwnerHealthDigest(report);
        await dependencies.deliver({ chatId: recipient.ownerTelegramUserId, text });
        await dependencies.complete(recipient.familyId, digestDate, now, text.length);
        console.info(JSON.stringify({
          code: "AGENT_OWNER_HEALTH_DIGEST_SENT",
          blockedLanes: report.lanes.blocked.length,
          familyId: recipient.familyId,
          ingressFailures: report.ingressFailures.count,
          rotations: report.rotations.count,
        }));
        sent += 1;
      } catch (error) {
        // The claim goes back so the next tick retries; a lost digest is exactly the silence it exists to end.
        await dependencies.release(recipient.familyId, digestDate);
        console.error(JSON.stringify({
          code: "AGENT_OWNER_HEALTH_DIGEST_FAILED",
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
    claim: (familyId, digestDate, at) => ownerHealthDigestRepository.claim(familyId, digestDate, at),
    complete: (familyId, digestDate, at, length) => ownerHealthDigestRepository.complete(familyId, digestDate, at, length),
    deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
    recipients: () => ownerHealthDigestRepository.recipients(),
    release: (familyId, digestDate) => ownerHealthDigestRepository.release(familyId, digestDate),
    report: (familyId, windowStart, at) => ownerHealthDigestRepository.report(familyId, windowStart, at),
  })(now);
}
