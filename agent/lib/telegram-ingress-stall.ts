/**
 * One alert to the owner when a Telegram message is stuck in processing.
 *
 * Exports:
 * - `TELEGRAM_INGRESS_STALL_ALERT_AFTER_MS`: how long a dispatched message may stay unanswered.
 * - `claimStalledIngress`: marks and returns messages that crossed it and were not alerted yet.
 * - `dispatchIngressStallAlerts`: tells each owner, once per message.
 *
 * Key construct:
 * - On 2 October 2026 a private message stayed `processing` for 8.5 hours behind a turn whose step
 *   had lost its retry job; its lease kept being renewed, so nothing looked wrong. Workflow's
 *   stuck-run scan now re-enqueues such runs within 10–25 minutes; this alert is for what it misses.
 * - The claim is written before sending: a crash after the claim loses that one alert rather than
 *   repeating it every tick.
 * - An owner whose chat Telegram calls unreachable (bot blocked, account deleted) is skipped and the
 *   other owners still hear about it. When no owner can be reached, the claim goes back
 *   (`stall_alerted_at` cleared): the alert waits for an owner to write again instead of being spent.
 *   Such a message is logged at most once an hour (per process), not on every tick.
 */
import { database } from "./database.js";
import { ownerHealthDigestRepository, type OwnerHealthRecipient } from "./health/owner-health-digest-repository.js";
import {
  memoryReviewOwnerAlertTransport,
  TelegramRecipientUnreachableError,
} from "./memory-review/memory-review-owner-alert-transport.js";
import type { TelegramRecipientUnreachableReason } from "./telegram-reachability/recipient-failure.js";
import { telegramReachabilityRepository } from "./telegram-reachability/reachability-repository.js";

export const TELEGRAM_INGRESS_STALL_ALERT_AFTER_MS = 30 * 60 * 1000;
const UNREACHABLE_LOG_INTERVAL_MS = 60 * 60 * 1000;
// Update id → until when a message whose owners are all unreachable stays out of the log.
const deferredQuietUntil = new Map<string, number>();

export interface StalledIngress {
  chatType: string;
  receivedAt: Date;
  updateId: string;
}

export async function claimStalledIngress(
  stallAfterMs: number = TELEGRAM_INGRESS_STALL_ALERT_AFTER_MS,
): Promise<StalledIngress[]> {
  const result = await database().query<{ chat_type: string | null; received_at: Date; update_id: string }>(
    `UPDATE telegram_ingress_updates
        SET stall_alerted_at = now()
      WHERE status = 'processing' AND stall_alerted_at IS NULL
        AND dispatch_started_at < now() - make_interval(secs => $1::double precision)
      RETURNING update_id::text, received_at,
                coalesce(payload->'message'->'chat'->>'type', payload->'callback_query'->'message'->'chat'->>'type') AS chat_type`,
    [stallAfterMs / 1000],
  );
  return result.rows.map((row) => ({
    chatType: row.chat_type ?? "unknown",
    receivedAt: row.received_at,
    updateId: row.update_id,
  }));
}

/** Gives a claimed message back, so the next tick alerts again: nobody could be told. */
export async function releaseStalledIngress(updateId: string): Promise<void> {
  await database().query(
    "UPDATE telegram_ingress_updates SET stall_alerted_at = NULL WHERE update_id = $1 AND status = 'processing'",
    [updateId],
  );
}

function alertText(stalled: StalledIngress, now: Date): string {
  const minutes = Math.round((now.getTime() - stalled.receivedAt.getTime()) / 60_000);
  const where = stalled.chatType === "private" ? "в личном чате" : "в группе";
  return `Мия не ответила на сообщение ${where} уже ${minutes} мин (пришло в ` +
    `${stalled.receivedAt.toISOString().slice(11, 16)} UTC): ход, похоже, завис. ` +
    "Если ответа не будет, поможет перезапуск agent.";
}

export async function dispatchIngressStallAlerts(dependencies: {
  claim: () => Promise<StalledIngress[]>;
  deliver: (input: { chatId: string; text: string }) => Promise<void>;
  now?: () => Date;
  /** Gives the claim back when no owner could be told; absent in tests that do not need it. */
  release?: (updateId: string) => Promise<void>;
  recipients: () => Promise<OwnerHealthRecipient[]>;
  /** The reason an owner chat is skipped, read without a log line of its own. */
  unreachable?: (chatId: string) => Promise<TelegramRecipientUnreachableReason | null>;
  quietUntil?: Map<string, number>;
} = {
  claim: () => claimStalledIngress(),
  deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
  recipients: () => ownerHealthDigestRepository.recipients(),
  release: (updateId) => releaseStalledIngress(updateId),
  unreachable: (chatId) => telegramReachabilityRepository.unreachableReason(chatId),
}): Promise<number> {
  const stalled = await dependencies.claim();
  if (stalled.length === 0) return 0;
  // One installation serves one family in practice, so every owner hears about every stuck chat.
  const owners = await dependencies.recipients();
  const now = (dependencies.now ?? (() => new Date()))();
  const quietUntil = dependencies.quietUntil ?? deferredQuietUntil;
  for (const [updateId, until] of quietUntil) if (until <= now.getTime()) quietUntil.delete(updateId);
  for (const item of stalled) {
    const quiet = quietUntil.has(item.updateId);
    if (!quiet) {
      console.error(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_STALLED", receivedAt: item.receivedAt, updateId: item.updateId }));
    }
    let delivered = false;
    let skipped = 0;
    for (const owner of owners) {
      if (await dependencies.unreachable?.(owner.ownerTelegramUserId) != null) {
        skipped += 1;
        continue;
      }
      try {
        await dependencies.deliver({ chatId: owner.ownerTelegramUserId, text: alertText(item, now) });
        delivered = true;
      } catch (error) {
        if (!(error instanceof TelegramRecipientUnreachableError)) throw error;
        skipped += 1;
      }
    }
    if (delivered || skipped === 0) {
      quietUntil.delete(item.updateId);
      continue;
    }
    // Nobody could be told: the alert must not be spent on unreachable owners.
    await dependencies.release?.(item.updateId);
    if (!quiet) {
      console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_STALL_ALERT_DEFERRED", owners: skipped, updateId: item.updateId }));
      quietUntil.set(item.updateId, now.getTime() + UNREACHABLE_LOG_INTERVAL_MS);
    }
  }
  return stalled.length;
}
