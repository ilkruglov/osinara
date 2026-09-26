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
 * - Ported from artkruglov/homka (Apache-2.0) on 26 сентября 2026, without quiet hours.
 */
import { DEEPSEEK_BALANCE_ALERT_USD } from "../../config.js";
import {
  MemoryReviewOwnerAlertTransportError,
  memoryReviewOwnerAlertTransport,
} from "../memory-review/memory-review-owner-alert-transport.js";
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
}

export function createOwnerBalanceAlertDispatcher(dependencies: OwnerBalanceAlertDependencies) {
  return async function dispatchOwnerBalanceAlerts(now = new Date()): Promise<number> {
    const line = formatDeepSeekBalance(await dependencies.balance(), dependencies.thresholdUsd);
    if (line === null || !line.warning) return 0;
    const alertDate = now.toISOString().slice(0, 10);
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      if (!await dependencies.claim(recipient.familyId, alertDate, now)) continue;
      try {
        await dependencies.deliver({ chatId: recipient.ownerTelegramUserId, text: line.text });
        await dependencies.complete(recipient.familyId, alertDate, now);
        console.info(JSON.stringify({ code: "AGENT_OWNER_BALANCE_ALERT_SENT", familyId: recipient.familyId }));
        sent += 1;
      } catch (error) {
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
  })(now);
}
