/**
 * Durable evaluation of every interactive turn, and the summary the owner's digest reads.
 *
 * Export:
 * - `turnEvaluationRepository`: `recordOutcome` (the end-of-turn hook), `recordDelivery` (the
 *   channel, with the ids of Mia's messages), `recordReaction` (a Telegram reaction), `summary`
 *   (three levels over a window, by version).
 *
 * Key constructs:
 * - The outcome and the delivery arrive in either order, so both upsert by the Eve turn and set
 *   only their own columns.
 * - Satisfaction is read at summary time from the journal: a reaction on one of Mia's messages, a
 *   reply to one of them, or a correction phrase from the triggering person in the same chat and
 *   forum topic within ten minutes. Message text is read by the query and never stored here.
 * - Rows older than the retention window go when the summary runs.
 */
import { database } from "../database.js";
import type { RuntimeVersions } from "./runtime-versions.js";
import type { TurnProcessMetrics, TurnToolCall } from "./turn-process-metrics.js";

export type TurnChatKind = "external" | "family" | "private";

export interface TurnEvaluationIdentity {
  chatKind: TurnChatKind;
  eveSessionId: string;
  eveTurnId: string;
  familyId: string;
  telegramChatId: string | null;
  triggeringEntryId: string | null;
}

export interface TurnOutcomeInput {
  failedToolCount: number;
  failureCode: string | null;
  finishedAt: Date;
  loadedSkills: string[];
  metrics: TurnProcessMetrics;
  outcome: "completed" | "failed";
  stepCount: number;
  toolCalls: TurnToolCall[];
  versions: RuntimeVersions;
}

export interface TurnQualitySummary {
  delivered: number;
  failed: number;
  failedToolTurns: number;
  followUps: { corrections: number; repliesToMia: number };
  forbiddenTool: number;
  heavy: number;
  loops: number;
  reactions: { negative: number; other: number; positive: number };
  repeatAfterError: number;
  turns: number;
  versions: { failed: number; softwareVersion: string; turns: number }[];
}

/** A run of identical calls this long is a loop, not a poll. */
export const TURN_LOOP_MIN_RUN = 3;
/** The step count the backlog already treats as a heavy turn. */
export const TURN_HEAVY_MIN_STEPS = 8;
const FOLLOW_UP_WINDOW_MINUTES = 10;
const RETENTION_DAYS = 90;
const POSITIVE_REACTIONS = ["👍", "❤", "❤️", "🔥", "🥰", "👏", "😁", "🤣", "😍", "🏆", "💯", "🙏", "❤‍🔥", "🤩", "😘", "🎉"];
const NEGATIVE_REACTIONS = ["👎", "💩", "🤮", "🤬", "😡", "🥱", "🤡", "😐"];
/** Phrases a person uses to say the answer missed; a measurement, not a verdict. */
const CORRECTION_PATTERN = String.raw`(^|[^а-яё])(не то|не так|не об этом|не про то|неправ|ошиб|перепутал|путаешь|переделай|бред|чушь|неверно|ты о чём|при чём тут)`;

const sum = (rows: readonly { count: string }[]) => rows.reduce((total, row) => total + Number(row.count), 0);

export const turnEvaluationRepository = {
  async recordOutcome(identity: TurnEvaluationIdentity, input: TurnOutcomeInput): Promise<void> {
    await database().query(
      `INSERT INTO turn_evaluations
         (family_id, eve_session_id, eve_turn_id, chat_kind, telegram_chat_id, triggering_entry_id,
          finished_at, outcome, failure_code, step_count, tool_calls, failed_tool_count, loaded_skills,
          repeated_call_run, repeat_after_error, forbidden_tool,
          software_version, model_config_hash, prompt_hash)
       VALUES ($1, $2, $3, $4, $5,
               (SELECT id FROM telegram_group_messages WHERE id = $6::uuid),
               $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (eve_session_id, eve_turn_id) DO UPDATE SET
         finished_at = EXCLUDED.finished_at, outcome = EXCLUDED.outcome, failure_code = EXCLUDED.failure_code,
         step_count = EXCLUDED.step_count, tool_calls = EXCLUDED.tool_calls,
         failed_tool_count = EXCLUDED.failed_tool_count, loaded_skills = EXCLUDED.loaded_skills,
         repeated_call_run = EXCLUDED.repeated_call_run, repeat_after_error = EXCLUDED.repeat_after_error,
         forbidden_tool = EXCLUDED.forbidden_tool,
         triggering_entry_id = coalesce(turn_evaluations.triggering_entry_id, EXCLUDED.triggering_entry_id),
         telegram_chat_id = coalesce(turn_evaluations.telegram_chat_id, EXCLUDED.telegram_chat_id)`,
      [identity.familyId, identity.eveSessionId, identity.eveTurnId, identity.chatKind, identity.telegramChatId,
        identity.triggeringEntryId, input.finishedAt, input.outcome, input.failureCode?.slice(0, 120) ?? null,
        input.stepCount, JSON.stringify(input.toolCalls), input.failedToolCount, input.loadedSkills,
        input.metrics.repeatedCallRun, input.metrics.repeatAfterError, input.metrics.forbiddenTool,
        input.versions.softwareVersion, input.versions.modelConfigHash, input.versions.promptHash],
    );
  },

  async recordDelivery(
    identity: TurnEvaluationIdentity,
    input: { deliveredAt: Date; replyMessageIds: readonly string[]; versions: RuntimeVersions },
  ): Promise<void> {
    await database().query(
      `INSERT INTO turn_evaluations
         (family_id, eve_session_id, eve_turn_id, chat_kind, telegram_chat_id, triggering_entry_id,
          reply_message_ids, delivered_at, software_version, model_config_hash, prompt_hash)
       VALUES ($1, $2, $3, $4, $5, (SELECT id FROM telegram_group_messages WHERE id = $6::uuid),
               $7::bigint[], $8, $9, $10, $11)
       ON CONFLICT (eve_session_id, eve_turn_id) DO UPDATE SET
         reply_message_ids = EXCLUDED.reply_message_ids, delivered_at = EXCLUDED.delivered_at,
         telegram_chat_id = coalesce(turn_evaluations.telegram_chat_id, EXCLUDED.telegram_chat_id),
         triggering_entry_id = coalesce(turn_evaluations.triggering_entry_id, EXCLUDED.triggering_entry_id)`,
      [identity.familyId, identity.eveSessionId, identity.eveTurnId, identity.chatKind, identity.telegramChatId,
        identity.triggeringEntryId, input.replyMessageIds, input.deliveredAt,
        input.versions.softwareVersion, input.versions.modelConfigHash, input.versions.promptHash],
    );
  },

  /** Telegram dates are whole seconds, so the update id orders events of the same second (Codex review). */
  async recordReaction(input: {
    changedAt: Date;
    emojis: readonly string[];
    telegramChatId: string;
    telegramMessageId: string;
    telegramUserId: string;
    updateId: string;
  }): Promise<void> {
    await database().query(
      `INSERT INTO telegram_message_reactions
         (telegram_chat_id, telegram_message_id, telegram_user_id, emojis, changed_at, update_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (telegram_chat_id, telegram_message_id, telegram_user_id) DO UPDATE SET
         emojis = EXCLUDED.emojis, changed_at = EXCLUDED.changed_at, update_id = EXCLUDED.update_id,
         received_at = now()
       WHERE (telegram_message_reactions.changed_at, telegram_message_reactions.update_id)
           < (EXCLUDED.changed_at, EXCLUDED.update_id)`,
      [input.telegramChatId, input.telegramMessageId, input.telegramUserId, input.emojis, input.changedAt, input.updateId],
    );
  },

  async summary(familyId: string, windowStart: Date, now: Date): Promise<TurnQualitySummary> {
    const client = database();
    await client.query(
      "DELETE FROM turn_evaluations WHERE started_at < $1::timestamptz - make_interval(days => $2)",
      [now, RETENTION_DAYS],
    );
    await client.query(
      "DELETE FROM telegram_message_reactions WHERE received_at < $1::timestamptz - make_interval(days => $2)",
      [now, RETENTION_DAYS],
    );
    const totals = await client.query<Record<string, string>>(
      `SELECT count(*) AS turns,
              count(*) FILTER (WHERE outcome = 'failed') AS failed,
              count(*) FILTER (WHERE failed_tool_count > 0) AS failed_tool_turns,
              count(*) FILTER (WHERE repeated_call_run >= $3) AS loops,
              count(*) FILTER (WHERE repeat_after_error) AS repeat_after_error,
              count(*) FILTER (WHERE forbidden_tool) AS forbidden_tool,
              count(*) FILTER (WHERE step_count >= $4) AS heavy,
              count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered
         FROM turn_evaluations
        WHERE family_id = $1 AND started_at >= $2 AND started_at < $5`,
      [familyId, windowStart, TURN_LOOP_MIN_RUN, TURN_HEAVY_MIN_STEPS, now],
    );
    const versions = await client.query<{ failed: string; software_version: string; turns: string }>(
      `SELECT software_version, count(*)::text AS turns, count(*) FILTER (WHERE outcome = 'failed')::text AS failed
         FROM turn_evaluations
        WHERE family_id = $1 AND started_at >= $2 AND started_at < $3
        GROUP BY software_version ORDER BY software_version`,
      [familyId, windowStart, now],
    );
    const reactions = await client.query<{ count: string; tone: string }>(
      `SELECT CASE WHEN emoji = ANY($4::text[]) THEN 'positive'
                   WHEN emoji = ANY($5::text[]) THEN 'negative' ELSE 'other' END AS tone,
              count(*)::text AS count
         FROM turn_evaluations AS turn
         JOIN telegram_message_reactions AS reaction
           ON reaction.telegram_chat_id = turn.telegram_chat_id
          AND reaction.telegram_message_id = ANY(turn.reply_message_ids)
         CROSS JOIN LATERAL unnest(reaction.emojis) AS emoji
        WHERE turn.family_id = $1 AND turn.delivered_at >= $2 AND turn.delivered_at < $3
        GROUP BY tone`,
      [familyId, windowStart, now, POSITIVE_REACTIONS, NEGATIVE_REACTIONS],
    );
    // A follow-up is the triggering person's own message in the same chat soon after the answer.
    const followUps = await client.query<{ corrections: string; replies: string }>(
      `SELECT count(DISTINCT turn.id) FILTER (WHERE follow.reply_to_message_id = ANY(turn.reply_message_ids))::text AS replies,
              count(DISTINCT turn.id) FILTER (WHERE follow.content_text ~* $4)::text AS corrections
         FROM turn_evaluations AS turn
         JOIN telegram_group_messages AS trigger ON trigger.id = turn.triggering_entry_id
         JOIN telegram_group_messages AS follow
           ON follow.group_id IS NOT DISTINCT FROM trigger.group_id
          AND follow.conversation_id IS NOT DISTINCT FROM trigger.conversation_id
          AND follow.message_thread_id IS NOT DISTINCT FROM trigger.message_thread_id
          AND follow.actor_kind = 'user'
          AND follow.telegram_user_id = trigger.telegram_user_id
          AND follow.sent_at > turn.delivered_at
          AND follow.sent_at <= turn.delivered_at + make_interval(mins => $5)
        WHERE turn.family_id = $1 AND turn.delivered_at >= $2 AND turn.delivered_at < $3`,
      [familyId, windowStart, now, CORRECTION_PATTERN, FOLLOW_UP_WINDOW_MINUTES],
    );
    const total = totals.rows[0] ?? {};
    const tone = (name: string) => sum(reactions.rows.filter((row) => row.tone === name));
    return {
      delivered: Number(total.delivered ?? 0),
      failed: Number(total.failed ?? 0),
      failedToolTurns: Number(total.failed_tool_turns ?? 0),
      followUps: {
        corrections: Number(followUps.rows[0]?.corrections ?? 0),
        repliesToMia: Number(followUps.rows[0]?.replies ?? 0),
      },
      forbiddenTool: Number(total.forbidden_tool ?? 0),
      heavy: Number(total.heavy ?? 0),
      loops: Number(total.loops ?? 0),
      reactions: { negative: tone("negative"), other: tone("other"), positive: tone("positive") },
      repeatAfterError: Number(total.repeat_after_error ?? 0),
      turns: Number(total.turns ?? 0),
      versions: versions.rows.map((row) => ({
        failed: Number(row.failed), softwareVersion: row.software_version, turns: Number(row.turns),
      })),
    };
  },
};
