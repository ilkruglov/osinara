/**
 * Durable side of the reply gate: the verdict and the response kind, written next to the turn.
 *
 * Exports:
 * - `replyGateRepository.recordVerdict`: upserts the gate columns of a turn evaluation row by the
 *   Eve turn; a scored verdict, an unavailable vendor and a skipped gate each set their own status.
 * - `replyGateRepository.recordResponseKind`: how Mia actually answered (text, reaction, silence).
 *
 * Key construct:
 * - Same upsert contract as the outcome and the delivery writers: whichever arrives first creates
 *   the row, and each writer touches only its own columns.
 */
import { database } from "../database.js";
import type { RuntimeVersions } from "../turn-quality/runtime-versions.js";
import type { TurnEvaluationIdentity } from "../turn-quality/turn-evaluation-repository.js";
import type { ReplyGateMetrics } from "./reply-gate-state.js";

export type ReplyGateStatus = "scored" | "skipped" | "unavailable";
/** `reaction_failed`: the model chose a reaction and Telegram declined it, so nothing reached the person. */
export type TurnResponseKind = "reaction" | "reaction_failed" | "silent" | "text";

export interface ReplyGateScores {
  asked: number;
  escalates: number;
  register: string;
  registerConfidence: number;
  repeatsSelf: number;
  thirdParty: number;
  worth: number;
}

export interface ReplyGateVerdictInput {
  errorCode: string | null;
  latencyMs: number | null;
  metrics: ReplyGateMetrics | null;
  model: string | null;
  scores: ReplyGateScores | null;
  status: ReplyGateStatus;
  versions: RuntimeVersions;
}

const IDENTITY_COLUMNS = "family_id, eve_session_id, eve_turn_id, chat_kind, telegram_chat_id, triggering_entry_id, software_version, model_config_hash, prompt_hash";
const IDENTITY_VALUES = "$1, $2, $3, $4, $5, (SELECT id FROM telegram_group_messages WHERE id = $6::uuid), $7, $8, $9";
const IDENTITY_MERGE = `telegram_chat_id = coalesce(turn_evaluations.telegram_chat_id, EXCLUDED.telegram_chat_id),
         triggering_entry_id = coalesce(turn_evaluations.triggering_entry_id, EXCLUDED.triggering_entry_id)`;

function identityParams(identity: TurnEvaluationIdentity, versions: RuntimeVersions): unknown[] {
  return [identity.familyId, identity.eveSessionId, identity.eveTurnId, identity.chatKind, identity.telegramChatId,
    identity.triggeringEntryId, versions.softwareVersion, versions.modelConfigHash, versions.promptHash];
}

export const replyGateRepository = {
  async recordResponseKind(identity: TurnEvaluationIdentity, kind: TurnResponseKind, versions: RuntimeVersions): Promise<void> {
    await database().query(
      `INSERT INTO turn_evaluations (${IDENTITY_COLUMNS}, response_kind)
       VALUES (${IDENTITY_VALUES}, $10)
       ON CONFLICT (eve_session_id, eve_turn_id) DO UPDATE SET
         response_kind = EXCLUDED.response_kind, ${IDENTITY_MERGE}`,
      [...identityParams(identity, versions), kind],
    );
  },

  async recordVerdict(identity: TurnEvaluationIdentity, input: ReplyGateVerdictInput): Promise<void> {
    const scores = input.scores;
    await database().query(
      `INSERT INTO turn_evaluations
         (${IDENTITY_COLUMNS}, trigger_kind, reply_chain_depth, same_author_run,
          gate_status, gate_error_code, gate_model, gate_latency_ms, gate_register, gate_register_confidence,
          gate_worth, gate_escalates, gate_third_party, gate_repeats_self, gate_asked)
       VALUES (${IDENTITY_VALUES}, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
       ON CONFLICT (eve_session_id, eve_turn_id) DO UPDATE SET
         trigger_kind = EXCLUDED.trigger_kind, reply_chain_depth = EXCLUDED.reply_chain_depth,
         same_author_run = EXCLUDED.same_author_run, gate_status = EXCLUDED.gate_status,
         gate_error_code = EXCLUDED.gate_error_code, gate_model = EXCLUDED.gate_model,
         gate_latency_ms = EXCLUDED.gate_latency_ms, gate_register = EXCLUDED.gate_register,
         gate_register_confidence = EXCLUDED.gate_register_confidence, gate_worth = EXCLUDED.gate_worth,
         gate_escalates = EXCLUDED.gate_escalates, gate_third_party = EXCLUDED.gate_third_party,
         gate_repeats_self = EXCLUDED.gate_repeats_self, gate_asked = EXCLUDED.gate_asked, ${IDENTITY_MERGE}`,
      [...identityParams(identity, input.versions),
        input.metrics?.triggerKind ?? null, input.metrics?.replyChainDepth ?? null, input.metrics?.sameAuthorRun ?? null,
        input.status, input.errorCode?.slice(0, 80) ?? null, input.model?.slice(0, 40) ?? null, input.latencyMs,
        scores?.register.slice(0, 20) ?? null, scores?.registerConfidence ?? null, scores?.worth ?? null,
        scores?.escalates ?? null, scores?.thirdParty ?? null, scores?.repeatsSelf ?? null, scores?.asked ?? null],
    );
  },
};
