/**
 * Durable side of the exchange measurement: the metrics and the response kind, written next to the turn.
 *
 * Exports:
 * - `turnExchangeRepository.recordMetrics`: upserts the exchange columns of a turn evaluation row.
 * - `turnExchangeRepository.recordResponseKind`: how Mia actually answered (text, reaction, silence).
 * - `TurnResponseKind`.
 *
 * Key construct:
 * - Same upsert contract as the outcome and the delivery writers: whichever arrives first creates
 *   the row, and each writer touches only its own columns. The `gate_*` columns of migration 133
 *   belong to the removed reply judge and are no longer written.
 */
import { database } from "../database.js";
import type { RuntimeVersions } from "./runtime-versions.js";
import type { ExchangeMetrics } from "./turn-exchange-metrics.js";
import type { TurnEvaluationIdentity } from "./turn-evaluation-repository.js";

/** `reaction_failed`: the model chose a reaction and Telegram declined it, so nothing reached the person. */
export type TurnResponseKind = "reaction" | "reaction_failed" | "silent" | "text";

const IDENTITY_COLUMNS =
  "family_id, eve_session_id, eve_turn_id, chat_kind, telegram_chat_id, triggering_entry_id, software_version, model_config_hash, prompt_hash";
const IDENTITY_VALUES =
  "$1, $2, $3, $4, $5, (SELECT id FROM telegram_group_messages WHERE id = $6::uuid), $7, $8, $9";
const IDENTITY_MERGE = `telegram_chat_id = coalesce(turn_evaluations.telegram_chat_id, EXCLUDED.telegram_chat_id),
         triggering_entry_id = coalesce(turn_evaluations.triggering_entry_id, EXCLUDED.triggering_entry_id)`;

function identityParams(identity: TurnEvaluationIdentity, versions: RuntimeVersions): unknown[] {
  return [
    identity.familyId,
    identity.eveSessionId,
    identity.eveTurnId,
    identity.chatKind,
    identity.telegramChatId,
    identity.triggeringEntryId,
    versions.softwareVersion,
    versions.modelConfigHash,
    versions.promptHash,
  ];
}

export const turnExchangeRepository = {
  async recordMetrics(
    identity: TurnEvaluationIdentity,
    metrics: ExchangeMetrics,
    versions: RuntimeVersions,
  ): Promise<void> {
    await database().query(
      `INSERT INTO turn_evaluations (${IDENTITY_COLUMNS}, trigger_kind, reply_chain_depth, same_author_run)
       VALUES (${IDENTITY_VALUES}, $10, $11, $12)
       ON CONFLICT (eve_session_id, eve_turn_id) DO UPDATE SET
         trigger_kind = EXCLUDED.trigger_kind, reply_chain_depth = EXCLUDED.reply_chain_depth,
         same_author_run = EXCLUDED.same_author_run, ${IDENTITY_MERGE}`,
      [
        ...identityParams(identity, versions),
        metrics.triggerKind,
        metrics.replyChainDepth,
        metrics.sameAuthorRun,
      ],
    );
  },

  async recordResponseKind(
    identity: TurnEvaluationIdentity,
    kind: TurnResponseKind,
    versions: RuntimeVersions,
  ): Promise<void> {
    await database().query(
      `INSERT INTO turn_evaluations (${IDENTITY_COLUMNS}, response_kind)
       VALUES (${IDENTITY_VALUES}, $10)
       ON CONFLICT (eve_session_id, eve_turn_id) DO UPDATE SET
         response_kind = EXCLUDED.response_kind, ${IDENTITY_MERGE}`,
      [...identityParams(identity, versions), kind],
    );
  },
};
