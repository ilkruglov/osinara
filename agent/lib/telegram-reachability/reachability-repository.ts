/**
 * Durable reachability of Telegram chats (migration 138).
 *
 * Exports:
 * - `TelegramMembershipChange`, `TelegramInboundEvidence`: the inputs of the writes below.
 * - `TelegramReachabilityRepository`: the injectable contract of the operations below.
 * - `telegramReachabilityRepository`: PostgreSQL implementation.
 *
 * Key constructs:
 * - `markUndeliverable`: a classified delivery failure marks the chat, keeping the first moment, but
 *   only when no proof of reachability arrived after that send started. A 403 is Telegram's answer at
 *   the moment of the request; an unblock or a message received meanwhile is newer than it. The check
 *   and the write are one statement on one row, so a concurrent proof cannot slip between them.
 * - `applyMembershipChange`: Telegram's `my_chat_member` marks or clears the chat, but only when it
 *   is newer than the last applied one: parallel webhook connections may deliver a block and the
 *   following unblock in either order. A change that shows the bot present is proof of reachability.
 *   A removal (`kicked`, `left`) also has to be newer than the last proof, compared as (Telegram date,
 *   update id): a removal delivered late after a newer message, unblock or return never silences a
 *   chat that reaches the bot. The date comes first because update ids restart at a random number after
 *   a week without updates (Bot API, `Update`); a fresh removal with a smaller id still wins by date.
 * - `recordInboundMessage`: a message from the chat proves the bot is reachable there and clears the
 *   mark. A message that is not newer than the last applied membership change, by date and then by
 *   update id, proves nothing about it. The proof is recorded even for a chat without a mark, so a
 *   late 403 of an older send cannot mark it afterwards.
 * - Proof times are the application's receipt times and send starts come from the same clock, so a
 *   stale answer is told by comparison, not by Telegram's second-precision dates.
 * - `unreachableReason`: what a proactive send reads before it writes.
 */
import type { Pool, PoolClient } from "pg";

import { database } from "../database.js";
import type { TelegramRecipientUnreachableReason } from "./recipient-failure.js";

export interface TelegramMembershipChange {
  readonly changedAt: Date;
  readonly chatId: string;
  /** Null when the change shows the bot back in the chat. */
  readonly reason: TelegramRecipientUnreachableReason | null;
  /** When the application received the update. */
  readonly receivedAt: Date;
  readonly updateId: string;
}

export interface TelegramInboundEvidence {
  readonly chatId: string;
  readonly receivedAt: Date;
  readonly sentAt: Date;
  readonly updateId: string;
}

export interface TelegramReachabilityRepository {
  applyMembershipChange(change: TelegramMembershipChange): Promise<boolean>;
  /** Null when the message is not newer than the last membership change; otherwise whether a mark was cleared. */
  recordInboundMessage(evidence: TelegramInboundEvidence): Promise<{ readonly cleared: boolean } | null>;
  /** False when a proof of reachability arrived after the failed send started. */
  markUndeliverable(chatId: string, reason: TelegramRecipientUnreachableReason, sendStartedAt: Date): Promise<boolean>;
  unreachableReason(chatId: string, client?: Pool | PoolClient): Promise<TelegramRecipientUnreachableReason | null>;
}

// Keeps the newer proof as one (Telegram date, update id) pair: the later date wins, an equal date goes
// by update id. The two columns move together, so the pair is never mixed from two proofs.
const NEWER_EVIDENCE_CONDITION = `current.reachable_evidence_telegram_at IS NULL
               OR (EXCLUDED.reachable_evidence_telegram_at, EXCLUDED.reachable_evidence_update_id)
                  > (current.reachable_evidence_telegram_at, current.reachable_evidence_update_id)`;
const NEWER_EVIDENCE = `reachable_evidence_telegram_at = CASE WHEN EXCLUDED.reachable_evidence_telegram_at IS NOT NULL
               AND (${NEWER_EVIDENCE_CONDITION})
               THEN EXCLUDED.reachable_evidence_telegram_at ELSE current.reachable_evidence_telegram_at END,
             reachable_evidence_update_id = CASE WHEN EXCLUDED.reachable_evidence_telegram_at IS NOT NULL
               AND (${NEWER_EVIDENCE_CONDITION})
               THEN EXCLUDED.reachable_evidence_update_id ELSE current.reachable_evidence_update_id END,`;

export const telegramReachabilityRepository: TelegramReachabilityRepository = {
  async markUndeliverable(chatId, reason, sendStartedAt) {
    const result = await database().query(
      `INSERT INTO telegram_chat_reachability AS current
         (telegram_chat_id, unreachable_reason, unreachable_since, source)
       VALUES ($1, $2, now(), 'delivery')
       ON CONFLICT (telegram_chat_id) DO UPDATE
         SET unreachable_reason = EXCLUDED.unreachable_reason,
             unreachable_since = COALESCE(current.unreachable_since, EXCLUDED.unreachable_since),
             source = 'delivery', updated_at = now()
         WHERE current.reachable_evidence_at IS NULL OR current.reachable_evidence_at <= $3
       RETURNING 1`,
      [chatId, reason, sendStartedAt],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async applyMembershipChange(change) {
    const result = await database().query(
      `INSERT INTO telegram_chat_reachability AS current
         (telegram_chat_id, unreachable_reason, unreachable_since, source,
          membership_update_id, membership_changed_at,
          reachable_evidence_at, reachable_evidence_telegram_at, reachable_evidence_update_id)
       VALUES ($1, $2::text, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
               'membership_update', $3, $4, CASE WHEN $2::text IS NULL THEN $5::timestamptz END,
               CASE WHEN $2::text IS NULL THEN $4::timestamptz END, CASE WHEN $2::text IS NULL THEN $3::bigint END)
       ON CONFLICT (telegram_chat_id) DO UPDATE
         SET unreachable_reason = EXCLUDED.unreachable_reason,
             unreachable_since = CASE WHEN EXCLUDED.unreachable_reason IS NULL THEN NULL
               ELSE COALESCE(current.unreachable_since, EXCLUDED.unreachable_since) END,
             source = 'membership_update',
             membership_update_id = EXCLUDED.membership_update_id,
             membership_changed_at = EXCLUDED.membership_changed_at,
             reachable_evidence_at = GREATEST(current.reachable_evidence_at, EXCLUDED.reachable_evidence_at),
             ${NEWER_EVIDENCE}
             updated_at = now()
         WHERE (current.membership_changed_at IS NULL
                OR (EXCLUDED.membership_changed_at, EXCLUDED.membership_update_id)
                   > (current.membership_changed_at, current.membership_update_id))
           AND (EXCLUDED.unreachable_reason IS NULL
                OR current.reachable_evidence_telegram_at IS NULL
                OR (EXCLUDED.membership_changed_at, EXCLUDED.membership_update_id)
                   > (current.reachable_evidence_telegram_at, current.reachable_evidence_update_id))
       RETURNING 1`,
      [change.chatId, change.reason, change.updateId, change.changedAt, change.receivedAt],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async recordInboundMessage(evidence) {
    // `prior` reads the statement's snapshot, before the upsert; `cleared` only decides a log line, and two
    // concurrent messages may both report the same transition.
    const result = await database().query<{ cleared: boolean }>(
      `WITH prior AS (
         SELECT unreachable_reason FROM telegram_chat_reachability WHERE telegram_chat_id = $1
       )
       INSERT INTO telegram_chat_reachability AS current
         (telegram_chat_id, source, reachable_evidence_at, reachable_evidence_telegram_at, reachable_evidence_update_id)
       VALUES ($1, 'inbound_message', $4, $2, $3::bigint)
       ON CONFLICT (telegram_chat_id) DO UPDATE
         SET unreachable_reason = NULL, unreachable_since = NULL, source = 'inbound_message',
             reachable_evidence_at = GREATEST(current.reachable_evidence_at, EXCLUDED.reachable_evidence_at),
             ${NEWER_EVIDENCE}
             updated_at = now()
         WHERE current.membership_changed_at IS NULL
            OR ($2::timestamptz, $3::bigint) > (current.membership_changed_at, current.membership_update_id)
       RETURNING (SELECT unreachable_reason IS NOT NULL FROM prior) IS TRUE AS cleared`,
      [evidence.chatId, evidence.sentAt, evidence.updateId, evidence.receivedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : { cleared: row.cleared };
  },

  async unreachableReason(chatId, client = database()) {
    const result = await client.query<{ unreachable_reason: TelegramRecipientUnreachableReason | null }>(
      "SELECT unreachable_reason FROM telegram_chat_reachability WHERE telegram_chat_id = $1",
      [chatId],
    );
    return result.rows[0]?.unreachable_reason ?? null;
  },
};
