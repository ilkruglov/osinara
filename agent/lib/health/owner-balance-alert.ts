/**
 * Low DeepSeek balance alert for the family owner.
 *
 * Exports:
 * - `createOwnerBalanceAlertDispatcher` / `dispatchOwnerBalanceAlerts`: one alert per day per owner.
 *
 * Key constructs:
 * - A spent balance means the bot answers nothing until a person looks (homka, 14 сентября 2026:
 *   −0,04 $ and silence). The morning digest is too late for that, so the ten-minute health tick
 *   reads the balance and warns the owner the first time it is low or blocked on a UTC day.
 * - Sent through the Bot API without the model, so it arrives even when every model call is 402.
 * - A definite Telegram refusal releases the claim; an unclear send stays terminal with a code.
 * - An owner chat Telegram calls unreachable (bot blocked, account deleted) is skipped before the claim,
 *   so the alert arrives on the first tick after the owner writes again. The skip is logged at most once
 *   an hour per family (per process), not on every ten-minute tick; a chat marked between the check and
 *   the send releases the claim without a failure line.
 * - Ported from artkruglov/homka (Apache-2.0) on 26 сентября 2026, without quiet hours.
 */
import { DEEPSEEK_BALANCE_ALERT_USD } from "../../config.js";
import {
  MemoryReviewOwnerAlertTransportError,
  memoryReviewOwnerAlertTransport,
  TelegramRecipientUnreachableError,
} from "../memory-review/memory-review-owner-alert-transport.js";
import type { TelegramRecipientUnreachableReason } from "../telegram-reachability/recipient-failure.js";
import { telegramReachabilityRepository } from "../telegram-reachability/reachability-repository.js";
import { type DeepSeekBalance, formatDeepSeekBalance, readConfiguredDeepSeekBalance } from "./deepseek-balance.js";
import { ownerBalanceAlertRepository } from "./owner-balance-alert-repository.js";
import { type OwnerHealthRecipient, ownerHealthDigestRepository } from "./owner-health-digest-repository.js";

interface OwnerBalanceAlertDependencies {
  abandon(familyId: string, alertDate: string, diagnosticCode: string): Promise<void>;
  balance(): Promise<DeepSeekBalance | null>;
  claim(familyId: string, alertDate: string, now: Date): Promise<boolean>;
  complete(familyId: string, alertDate: string, now: Date): Promise<void>;
  deliver(input: { chatId: string; text: string }): Promise<void>;
  recipients(): Promise<OwnerHealthRecipient[]>;
  release(familyId: string, alertDate: string): Promise<void>;
  readonly thresholdUsd: number;
  /** The reason the owner chat is skipped, read without a log line of its own; absent in older tests. */
  unreachable?(chatId: string): Promise<TelegramRecipientUnreachableReason | null>;
  quietUntil?: Map<string, number>;
}

const UNREACHABLE_LOG_INTERVAL_MS = 60 * 60 * 1000;
// Family id → until when its skipped alert stays out of the log.
const skippedQuietUntil = new Map<string, number>();

export function createOwnerBalanceAlertDispatcher(dependencies: OwnerBalanceAlertDependencies) {
  return async function dispatchOwnerBalanceAlerts(now = new Date()): Promise<number> {
    const line = formatDeepSeekBalance(await dependencies.balance(), dependencies.thresholdUsd);
    if (line === null || !line.warning) return 0;
    const alertDate = now.toISOString().slice(0, 10);
    const quietUntil = dependencies.quietUntil ?? skippedQuietUntil;
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      const reason = await dependencies.unreachable?.(recipient.ownerTelegramUserId) ?? null;
      if (reason !== null) {
        if ((quietUntil.get(recipient.familyId) ?? 0) <= now.getTime()) {
          console.warn(JSON.stringify({ code: "AGENT_OWNER_BALANCE_ALERT_DEFERRED", familyId: recipient.familyId, reason }));
          quietUntil.set(recipient.familyId, now.getTime() + UNREACHABLE_LOG_INTERVAL_MS);
        }
        continue;
      }
      quietUntil.delete(recipient.familyId);
      if (!await dependencies.claim(recipient.familyId, alertDate, now)) continue;
      try {
        await dependencies.deliver({ chatId: recipient.ownerTelegramUserId, text: line.text });
        await dependencies.complete(recipient.familyId, alertDate, now);
        console.info(JSON.stringify({ code: "AGENT_OWNER_BALANCE_ALERT_SENT", familyId: recipient.familyId }));
        sent += 1;
      } catch (error) {
        // Marked between the check and the send: nothing was sent, the next tick checks again.
        if (error instanceof TelegramRecipientUnreachableError) {
          await dependencies.release(recipient.familyId, alertDate);
          continue;
        }
        const refused = error instanceof MemoryReviewOwnerAlertTransportError;
        if (refused) await dependencies.release(recipient.familyId, alertDate);
        else await dependencies.abandon(recipient.familyId, alertDate, "AGENT_OWNER_BALANCE_ALERT_AMBIGUOUS");
        console.error(JSON.stringify({
          code: refused ? "AGENT_OWNER_BALANCE_ALERT_FAILED" : "AGENT_OWNER_BALANCE_ALERT_AMBIGUOUS",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}

export function dispatchOwnerBalanceAlerts(now = new Date()): Promise<number> {
  return createOwnerBalanceAlertDispatcher({
    abandon: (familyId, alertDate, code) => ownerBalanceAlertRepository.abandon(familyId, alertDate, code),
    balance: readConfiguredDeepSeekBalance,
    claim: (familyId, alertDate, at) => ownerBalanceAlertRepository.claim(familyId, alertDate, at),
    complete: (familyId, alertDate, at) => ownerBalanceAlertRepository.complete(familyId, alertDate, at),
    deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
    recipients: () => ownerHealthDigestRepository.recipients(),
    release: (familyId, alertDate) => ownerBalanceAlertRepository.release(familyId, alertDate),
    thresholdUsd: DEEPSEEK_BALANCE_ALERT_USD,
    unreachable: (chatId) => telegramReachabilityRepository.unreachableReason(chatId),
  })(now);
}
