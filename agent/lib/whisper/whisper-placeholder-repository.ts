/**
 * Durable state of whisper placeholders (migration 144).
 *
 * Exports:
 * - `WhisperPlaceholderStatus`, `WhisperPlaceholderContent`, `WhisperPlaceholderKey`: the record.
 * - `WHISPER_PLACEHOLDER_MAX_ATTEMPTS`: edits tried before the placeholder is left as it is.
 * - `WhisperPlaceholderRepository`, `whisperPlaceholderRepository`: the table.
 *
 * Key constructs:
 * - `transition` writes the new status and the content it shows before Telegram is called, and only
 *   from the statuses the caller names: an answer never yields to a later failure notice, a failure
 *   never to the «no answer» fallback. An unconfirmed edit stays in `pending_content` for the sweep.
 * - `settle` acts only while the row still holds the content it settles, so a newer transition
 *   (progress text, then the answer) is never cleared by the older call's result.
 * - `claimDue` leases due edits for two minutes by moving their next attempt, so two sweeps do not
 *   call Telegram for the same edit at once; edits are idempotent, a rare overlap only repeats one.
 * - `listStale` finds an open placeholder nothing will finish: no stored update carries it (the
 *   queue write rolled back, or a redelivery queued another), or its update ended over two minutes
 *   ago without the turn telling the author.
 */
import { database } from "../database.js";
import type { TelegramWhisperContent } from "./telegram-whisper-api.js";

export type WhisperPlaceholderStatus = "answered" | "closed" | "failed" | "open" | "progress";
export type WhisperPlaceholderContent = TelegramWhisperContent | { readonly remove: true };

export interface WhisperPlaceholderKey {
  readonly chatId: string;
  readonly placeholderMessageId: number;
  readonly receiverUserId: string;
}

export interface WhisperPlaceholderTransition {
  readonly content: WhisperPlaceholderContent;
  readonly from: readonly WhisperPlaceholderStatus[];
  readonly to: WhisperPlaceholderStatus;
}

export interface DueWhisperPlaceholder extends WhisperPlaceholderKey {
  readonly attemptCount: number;
  readonly content: WhisperPlaceholderContent;
  readonly status: WhisperPlaceholderStatus;
}

export interface StaleWhisperPlaceholder extends WhisperPlaceholderKey {
  /** `orphan`: no stored update carries it; `unanswered`: its update ended and nothing was shown. */
  readonly reason: "orphan" | "unanswered";
}

export type WhisperPlaceholderSettlement =
  | { readonly outcome: "delivered" }
  | { readonly errorCode: string; readonly outcome: "refused" }
  | { readonly errorCode: string; readonly outcome: "retry" };

export const WHISPER_PLACEHOLDER_MAX_ATTEMPTS = 5;
const STALE_AFTER_SECONDS = 120;
const RETENTION_DAYS = 3;

export interface WhisperPlaceholderRepository {
  claimDue(limit: number): Promise<DueWhisperPlaceholder[]>;
  listStale(limit: number): Promise<StaleWhisperPlaceholder[]>;
  purge(): Promise<number>;
  record(input: WhisperPlaceholderKey & { updateId: string }): Promise<void>;
  /**
   * "final": nothing more will be tried; "waiting": the sweep tries again; "superseded": a newer
   * change holds the placeholder and this result is dropped.
   */
  settle(
    key: WhisperPlaceholderKey,
    transition: Omit<WhisperPlaceholderTransition, "from">,
    settlement: WhisperPlaceholderSettlement,
  ): Promise<"final" | "superseded" | "waiting">;
  /** "applied", "refused" (another status holds the placeholder) or "missing" (no such record). */
  transition(
    key: WhisperPlaceholderKey,
    transition: WhisperPlaceholderTransition,
  ): Promise<"applied" | "missing" | "refused">;
}

interface PlaceholderRow {
  attempt_count: number;
  pending_content: WhisperPlaceholderContent;
  placeholder_message_id: string;
  receiver_user_id: string;
  status: WhisperPlaceholderStatus;
  telegram_chat_id: string;
}

const KEY_MATCH =
  "telegram_chat_id = $1 AND placeholder_message_id = $2::bigint AND receiver_user_id = $3";
const keyValues = (key: WhisperPlaceholderKey) => [
  key.chatId,
  String(key.placeholderMessageId),
  key.receiverUserId,
];

export const whisperPlaceholderRepository: WhisperPlaceholderRepository = {
  async claimDue(limit) {
    const result = await database().query<PlaceholderRow>(
      `WITH due AS (
         SELECT telegram_chat_id, placeholder_message_id
           FROM telegram_whisper_placeholders
          WHERE pending_content IS NOT NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT $1::integer
          FOR UPDATE SKIP LOCKED
       )
       UPDATE telegram_whisper_placeholders placeholder
          SET next_attempt_at = now() + interval '2 minutes', updated_at = now()
         FROM due
        WHERE placeholder.telegram_chat_id = due.telegram_chat_id
          AND placeholder.placeholder_message_id = due.placeholder_message_id
       RETURNING placeholder.telegram_chat_id, placeholder.placeholder_message_id::text,
                 placeholder.receiver_user_id, placeholder.status, placeholder.pending_content,
                 placeholder.attempt_count`,
      [limit],
    );
    return result.rows.map((row) => ({
      attemptCount: row.attempt_count,
      chatId: row.telegram_chat_id,
      content: row.pending_content,
      placeholderMessageId: Number(row.placeholder_message_id),
      receiverUserId: row.receiver_user_id,
      status: row.status,
    }));
  },

  async listStale(limit) {
    const result = await database().query<PlaceholderRow & { reason: "orphan" | "unanswered" }>(
      `SELECT placeholder.telegram_chat_id, placeholder.placeholder_message_id::text, placeholder.receiver_user_id,
              CASE WHEN carried.update_id IS NULL THEN 'orphan' ELSE 'unanswered' END AS reason
         FROM telegram_whisper_placeholders placeholder
         LEFT JOIN LATERAL (
           SELECT update_row.update_id, update_row.status, COALESCE(update_row.completed_at, update_row.updated_at) AS ended_at
             FROM telegram_ingress_updates update_row
            WHERE update_row.update_id = placeholder.update_id
              AND update_row.payload -> 'message' -> 'osinara_whisper' ->> 'placeholderMessageId'
                  = placeholder.placeholder_message_id::text
         ) carried ON true
        WHERE placeholder.status = 'open'
          AND placeholder.pending_content IS NULL
          AND placeholder.created_at < now() - ($2::integer * interval '1 second')
          AND (carried.update_id IS NULL
            OR (carried.status IN ('completed', 'failed')
                AND carried.ended_at < now() - ($2::integer * interval '1 second')))
        ORDER BY placeholder.created_at
        LIMIT $1::integer`,
      [limit, STALE_AFTER_SECONDS],
    );
    return result.rows.map((row) => ({
      chatId: row.telegram_chat_id,
      placeholderMessageId: Number(row.placeholder_message_id),
      reason: row.reason,
      receiverUserId: row.receiver_user_id,
    }));
  },

  async purge() {
    const result = await database().query(
      `DELETE FROM telegram_whisper_placeholders
        WHERE updated_at < now() - ($1::integer * interval '1 day')`,
      [RETENTION_DAYS],
    );
    return result.rowCount ?? 0;
  },

  async record(input) {
    await database().query(
      `INSERT INTO telegram_whisper_placeholders
         (telegram_chat_id, placeholder_message_id, receiver_user_id, update_id)
       VALUES ($1, $2::bigint, $3, $4::bigint)
       ON CONFLICT (telegram_chat_id, placeholder_message_id) DO NOTHING`,
      [...keyValues(input), input.updateId],
    );
  },

  async settle(key, transition, settlement) {
    const held = `${KEY_MATCH} AND status = $4 AND pending_content = $5::jsonb`;
    const values = [...keyValues(key), transition.to, JSON.stringify(transition.content)];
    if (settlement.outcome !== "retry") {
      const result = await database().query(
        `UPDATE telegram_whisper_placeholders
            SET pending_content = NULL, next_attempt_at = NULL, last_error_code = $6, updated_at = now()
          WHERE ${held}`,
        [...values, settlement.outcome === "refused" ? settlement.errorCode : null],
      );
      return (result.rowCount ?? 0) > 0 ? "final" : "superseded";
    }
    // Right-hand sides read the old row: attempt_count + 1 is this attempt.
    const result = await database().query<{ abandoned: boolean }>(
      `UPDATE telegram_whisper_placeholders
          SET attempt_count = attempt_count + 1,
              pending_content = CASE WHEN attempt_count + 1 >= $7::integer THEN NULL ELSE pending_content END,
              next_attempt_at = CASE WHEN attempt_count + 1 >= $7::integer THEN NULL
                                     ELSE now() + (attempt_count + 1) * interval '1 minute' END,
              last_error_code = $6,
              updated_at = now()
        WHERE ${held}
       RETURNING pending_content IS NULL AS abandoned`,
      [...values, settlement.errorCode, WHISPER_PLACEHOLDER_MAX_ATTEMPTS],
    );
    const row = result.rows[0];
    if (row === undefined) return "superseded";
    return row.abandoned ? "final" : "waiting";
  },

  async transition(key, transition) {
    const result = await database().query(
      `UPDATE telegram_whisper_placeholders
          SET status = $4, pending_content = $5::jsonb, attempt_count = 0, last_error_code = NULL,
              next_attempt_at = now() + interval '1 minute', updated_at = now()
        WHERE ${KEY_MATCH} AND status = ANY($6::text[])`,
      [...keyValues(key), transition.to, JSON.stringify(transition.content), [...transition.from]],
    );
    if ((result.rowCount ?? 0) > 0) return "applied";
    const existing = await database().query(
      `SELECT 1 FROM telegram_whisper_placeholders WHERE ${KEY_MATCH}`,
      keyValues(key),
    );
    return existing.rowCount === 0 ? "missing" : "refused";
  },
};
