/**
 * Authorized R3 chat-local profile projection and reproducible view boundary.
 *
 * Exports:
 * - `profileViewRepository`: creates immutable selections and reads the exact authorized snapshot.
 * - Re-exported profile view contracts and formatter from `profile-view`.
 */
import type { PoolClient } from "pg";

import {
  requireConversationAccess,
  timelineReplyTelegramUserIds,
  type ProfileConversationBoundary,
} from "./profile-conversation-access.js";
import { database } from "./database.js";
import { PROFILE_SELECTION_DORMANCY_MILLISECONDS } from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { MemoryConfirmation, MemoryKind } from "./memory-record.js";
import { externalProfileProjectionPredicate } from "./external-profile-projection-predicate.js";
import {
  selectProfileClaims,
  type ProfileClaimCandidate,
  type ProfileSubjectPriority,
} from "./profile-selection.js";
import { toProfileView, type CreateProfileViewInput, type ProfileView } from "./profile-view.js";
import { readProfileView } from "./profile-view-read.js";

import { participantLabel } from "./telegram-participant-label.js";

export {
  formatProfileViewContext,
  type CreateProfileViewInput,
  type ProfileView,
  type ProfileViewClaim,
  type ProfileViewSubject,
} from "./profile-view.js";

interface SubjectRow {
  id: string;
  last_verified_at: Date;
  subject_participant_id: string | null;
  subject_ref: string;
  subject_user_id: string | null;
  telegram_user_id: string;
  display_label_snapshot: string;
  /** Group participants only: the card labels them «Имя (username)» to keep namesakes apart. */
  username_snapshot: string | null;
}

interface ClaimRow {
  claim_status: "active" | "duplicate" | "superseded";
  confirmation: MemoryConfirmation;
  content: string;
  attribute: string | null;
  evidence_kind: "firsthand" | "inferred" | "reported" | "unresolved";
  id: string;
  kind: MemoryKind;
  linked_subject_user_id: string | null;
  memory_ref: string;
  origin_label: string;
  origin_scope: MemoryScope;
  observed_at: Date;
  profile_eligible: boolean;
  sensitivity: "normal" | "sensitive";
  source_author_label: string;
  subject_participant_id: string | null;
  subject_user_id: string | null;
  updated_at: Date;
}

function signalPriority(
  input: CreateProfileViewInput,
  resolvedReplyTelegramUserId: string | null,
): Map<string, ProfileSubjectPriority> {
  const result = new Map<string, ProfileSubjectPriority>();
  const add = (value: string, priority: ProfileSubjectPriority) => {
    if (!result.has(value)) result.set(value, priority);
  };
  if (input.suppressCurrentAuthor !== true) add(input.currentTelegramUserId, "current_author");
  if (resolvedReplyTelegramUserId) add(resolvedReplyTelegramUserId, "reply_subject");
  for (const telegramUserId of input.explicitMentionTelegramUserIds) {
    add(telegramUserId, "explicit_mention");
  }
  return result;
}

async function loadSubjects(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateProfileViewInput,
  conversation: ProfileConversationBoundary,
  personCardIds: readonly string[],
): Promise<Array<SubjectRow & { priority: ProfileSubjectPriority }>> {
  const timelineReply =
    input.replyTelegramUserId === null && input.replyTimelineSequence
      ? await timelineReplyTelegramUserIds(
          client,
          input.conversationId,
          input.replyTimelineSequence,
        )
      : [];
  const signals = signalPriority(input, input.replyTelegramUserId ?? timelineReply[0] ?? null);
  // A suppressed current author is out of the view entirely: not by the direct pick, and not
  // through a retrieval-related claim about them, or the card returned on the very next turn.
  const suppressedTelegramUserId =
    input.suppressCurrentAuthor === true ? input.currentTelegramUserId : null;
  const telegramUserIds = (
    conversation.scope === "personal" ? [auth.telegramUserId] : [...signals.keys()]
  ).filter((telegramUserId) => telegramUserId !== suppressedTelegramUserId);
  const dormantBefore = new Date(input.now.getTime() - PROFILE_SELECTION_DORMANCY_MILLISECONDS);
  await client.query(
    `UPDATE profile_subjects SET dormant_at = $2, updated_at = now()
     WHERE conversation_id = $1 AND last_verified_at <= $3 AND dormant_at IS NULL`,
    [input.conversationId, input.now, dormantBefore],
  );
  const result = await client.query<SubjectRow>(
    `SELECT subject.id, subject.subject_ref, subject.subject_user_id,
            subject.subject_participant_id, subject.display_label_snapshot,
            participant.username_snapshot, subject.last_verified_at,
            CASE WHEN subject.subject_user_id IS NOT NULL
                 THEN app_user.telegram_user_id ELSE participant.telegram_user_id END AS telegram_user_id
     FROM profile_subjects AS subject
     LEFT JOIN users AS app_user ON app_user.id = subject.subject_user_id
     LEFT JOIN conversation_participants AS participant ON participant.id = subject.subject_participant_id
     WHERE subject.conversation_id = $1
       AND (
         -- A person whose card the turn shows is a subject too: what the card did not read goes
         -- here, though retrieval may have named them only by a label.
         (CASE WHEN subject.subject_user_id IS NOT NULL
               THEN app_user.telegram_user_id ELSE participant.telegram_user_id END) = ANY(
           $2::text[] || ARRAY(SELECT card.subject_telegram_user_id FROM person_cards AS card
                               WHERE card.id = ANY($7::uuid[])))
          OR EXISTS (
            SELECT 1
            FROM memory_items AS related_claim
            LEFT JOIN conversation_participants AS related_subject
              ON related_subject.id = related_claim.subject_participant_id
            WHERE related_claim.id = ANY($3::uuid[])
              AND (
                (subject.subject_user_id IS NOT NULL AND (
                  related_claim.subject_user_id = subject.subject_user_id OR
                  related_subject.linked_user_id = subject.subject_user_id
                )) OR
                (subject.subject_participant_id IS NOT NULL AND
                  related_claim.subject_participant_id = subject.subject_participant_id)
              )
          )
       )
       AND ($4::memory_scope <> 'family' OR EXISTS (
         SELECT 1 FROM family_memberships AS membership
         WHERE membership.family_id = $5 AND membership.user_id = subject.subject_user_id
       ))
       AND (CASE WHEN subject.subject_user_id IS NOT NULL
                 THEN app_user.telegram_user_id ELSE participant.telegram_user_id END)
           IS DISTINCT FROM $6::text
     ORDER BY subject.subject_ref`,
    [
      input.conversationId,
      telegramUserIds,
      input.retrievalClaimIds,
      conversation.scope,
      auth.familyId,
      suppressedTelegramUserId,
      personCardIds,
    ],
  );
  return result.rows.map((row) => ({
    ...row,
    priority: signals.get(row.telegram_user_id) ?? "retrieval_related",
  }));
}

async function loadClaims(
  client: PoolClient,
  auth: MemoryAuthorization,
  conversation: ProfileConversationBoundary,
  subjects: readonly SubjectRow[],
  personCardIds: readonly string[],
): Promise<ClaimRow[]> {
  const subjectUserIds = subjects.flatMap((subject) =>
    subject.subject_user_id ? [subject.subject_user_id] : [],
  );
  const subjectParticipantIds = subjects.flatMap((subject) =>
    subject.subject_participant_id ? [subject.subject_participant_id] : [],
  );
  const result = await client.query<ClaimRow>(
    `SELECT claim.id, ref.memory_ref, claim.content, claim.kind, claim.attribute, claim.confirmation,
            claim.sensitivity, claim.claim_status, claim.profile_eligible, claim.updated_at,
             claim.subject_user_id, claim.subject_participant_id,
             claim_subject.linked_user_id AS linked_subject_user_id,
             origin.scope AS origin_scope, origin.label AS origin_label,
             COALESCE(evidence.evidence_kind, 'unresolved') AS evidence_kind,
             COALESCE(evidence.observed_at, claim.created_at) AS observed_at,
             COALESCE(evidence.author_label_snapshot, 'Источник не установлен') AS source_author_label
     FROM memory_items AS claim
     JOIN memory_item_refs AS ref ON ref.memory_item_id = claim.id
     JOIN application_conversations AS origin ON origin.id = claim.origin_conversation_id
     LEFT JOIN conversation_participants AS claim_subject
       ON claim_subject.id = claim.subject_participant_id
      LEFT JOIN LATERAL (
        SELECT evidence_kind, observed_at, author_label_snapshot
        FROM claim_evidence WHERE claim_id = claim.id AND evidence_role = 'primary'
        ORDER BY observed_at, id LIMIT 1
      ) AS evidence ON true
     WHERE claim.family_id = $1
       AND claim.profile_eligible = true
        AND claim.claim_status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM claim_conflicts AS conflict
          WHERE conflict.resolution = 'unresolved'
            AND claim.id IN (conflict.claim_a_id, conflict.claim_b_id)
        )
       AND claim.sensitivity = 'normal'
       AND claim.kind <> 'episode'
       AND (
         ($2::memory_scope = 'personal' AND (
           (claim.scope = 'personal' AND claim.owner_user_id = $3
             AND (claim.subject_user_id = $3 OR claim_subject.linked_user_id = $3)) OR
           (claim.scope = 'family' AND (claim.subject_user_id = $3 OR claim_subject.linked_user_id = $3)) OR
            ${externalProfileProjectionPredicate({ claimAlias: "claim", viewerUserParameter: "$3" })}
         )) OR
         ($2::memory_scope = 'family' AND claim.scope = 'family'
           AND (claim.subject_user_id = ANY($4::uuid[])
                OR claim_subject.linked_user_id = ANY($4::uuid[]))) OR
         ($2::memory_scope = 'group' AND claim.scope = 'group' AND claim.group_id = $5
           AND claim.subject_participant_id = ANY($6::uuid[]))
       )
       -- A person shown by a card keeps here only what the card did not read.
       AND NOT EXISTS (
         SELECT 1 FROM person_card_reads AS known
         WHERE known.card_id = ANY($7::uuid[]) AND known.memory_item_id = claim.id
       )
     ORDER BY claim.id`,
    [
      auth.familyId,
      conversation.scope,
      auth.userId,
      subjectUserIds,
      auth.groupId,
      subjectParticipantIds,
      personCardIds,
    ],
  );
  return result.rows;
}

export const profileViewRepository = {
  async create(auth: MemoryAuthorization, input: CreateProfileViewInput): Promise<ProfileView> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const conversation = await requireConversationAccess(client, auth, input.conversationId);
      const personCardIds = input.personCardIds ?? [];
      const subjects = await loadSubjects(client, auth, input, conversation, personCardIds);
      const claims = await loadClaims(client, auth, conversation, subjects, personCardIds);
      const subjectByUser = new Map(
        subjects.flatMap((subject) =>
          subject.subject_user_id ? [[subject.subject_user_id, subject] as const] : [],
        ),
      );
      const subjectByParticipant = new Map(
        subjects.flatMap((subject) =>
          subject.subject_participant_id
            ? [[subject.subject_participant_id, subject] as const]
            : [],
        ),
      );
      const candidates = claims.flatMap((claim): ProfileClaimCandidate[] => {
        const subject =
          conversation.scope === "group" && claim.subject_participant_id
            ? subjectByParticipant.get(claim.subject_participant_id)
            : subjectByUser.get(claim.subject_user_id ?? claim.linked_subject_user_id ?? "");
        if (!subject) return [];
        return [
          {
            attribute: claim.attribute,
            claimStatus: claim.claim_status,
            confirmation: claim.confirmation,
            content: claim.content,
            evidenceKind: claim.evidence_kind,
            kind: claim.kind,
            lastVerifiedAt: subject.last_verified_at.toISOString(),
            memoryRef: claim.memory_ref,
            originLabel: claim.origin_label,
            originScope: claim.origin_scope,
            observedAt: claim.observed_at.toISOString(),
            priority: subject.priority,
            profileEligible: claim.profile_eligible,
            sensitivity: claim.sensitivity,
            sourceAuthorLabel: claim.source_author_label,
            subjectLabel:
              participantLabel(subject.display_label_snapshot, subject.username_snapshot) ??
              subject.display_label_snapshot,
            subjectRef: subject.subject_ref,
            updatedAt: claim.updated_at.toISOString(),
          },
        ];
      });
      const selection = selectProfileClaims(candidates, input.now, input.maxCharacters);
      const selectedClaims = selection.subjects.flatMap((subject) => subject.claims);
      const insertedView = await client.query<{
        created_at: Date;
        id: string;
        profile_view_ref: string;
      }>(
        `INSERT INTO profile_views
            (family_id, viewer_conversation_id, viewer_user_id, subject_count,
             claim_count, total_characters, eve_session_id, eve_turn_id, person_card_ids)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, profile_view_ref, created_at`,
        [
          auth.familyId,
          input.conversationId,
          auth.userId,
          selection.subjects.length,
          selectedClaims.length,
          selection.totalCharacters,
          input.provenance.sessionId,
          input.provenance.turnId,
          personCardIds,
        ],
      );
      const view = insertedView.rows[0]!;
      for (const [subjectOrdinal, selectedSubject] of selection.subjects.entries()) {
        const sourceSubject = subjects.find(
          (subject) => subject.subject_ref === selectedSubject.subjectRef,
        )!;
        await client.query(
          `INSERT INTO profile_view_subjects
             (profile_view_id, ordinal, profile_subject_id, subject_ref_snapshot,
              subject_label_snapshot, priority_reason, total_characters)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            view.id,
            subjectOrdinal,
            sourceSubject.id,
            selectedSubject.subjectRef,
            selectedSubject.subjectLabel,
            selectedSubject.priority,
            selectedSubject.totalCharacters,
          ],
        );
        for (const [claimOrdinal, selectedClaim] of selectedSubject.claims.entries()) {
          const sourceClaim = claims.find((claim) => claim.memory_ref === selectedClaim.memoryRef)!;
          await client.query(
            `INSERT INTO profile_view_claims
               (profile_view_id, subject_ordinal, claim_ordinal, claim_id, memory_ref_snapshot,
                 content_snapshot, kind, confirmation, origin_scope, origin_label_snapshot,
                 evidence_kind, observed_at, source_author_label_snapshot, rendered_characters,
                 attribute_snapshot)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              view.id,
              subjectOrdinal,
              claimOrdinal,
              sourceClaim.id,
              selectedClaim.memoryRef,
              selectedClaim.content,
              selectedClaim.kind,
              selectedClaim.confirmation,
              selectedClaim.originScope,
              selectedClaim.originLabel,
              selectedClaim.evidenceKind,
              selectedClaim.observedAt,
              selectedClaim.sourceAuthorLabel,
              selectedClaim.renderedText.length,
              selectedClaim.attribute,
            ],
          );
        }
      }
      await client.query("COMMIT");
      return toProfileView({
        generatedAt: view.created_at,
        profileViewRef: view.profile_view_ref,
        selection,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  read: readProfileView,
};
