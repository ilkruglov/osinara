/**
 * Re-reading a profile view snapshot exactly as a turn showed it.
 *
 * Export:
 * - `readProfileView`: the snapshot's claims, re-authorized against the current access and
 *   lifecycle; refuses with `AGENT_PROFILE_VIEW_ACCESS_CHANGED` when either changed since.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { externalProfileProjectionPredicate } from "./external-profile-projection-predicate.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { MemoryConfirmation, MemoryKind } from "./memory-record.js";
import { requireConversationAccess } from "./profile-conversation-access.js";
import type { ProfileSubjectPriority } from "./profile-selection.js";
import type { ProfileView, ProfileViewClaim, ProfileViewSubject } from "./profile-view.js";

export async function readProfileView(
  auth: MemoryAuthorization,
  profileViewRef: string,
): Promise<ProfileView> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const viewResult = await client.query<{
      claim_count: number;
      created_at: Date;
      id: string;
      total_characters: number;
      viewer_conversation_id: string;
    }>(
      `SELECT id, viewer_conversation_id, claim_count, total_characters, created_at
       FROM profile_views WHERE family_id = $1 AND profile_view_ref = $2 FOR SHARE`,
      [auth.familyId, profileViewRef],
    );
    const view = viewResult.rows[0];
    if (!view) throw new AppError("AGENT_PROFILE_VIEW_NOT_FOUND", "Снимок профиля не найден");
    const conversation = await requireConversationAccess(client, auth, view.viewer_conversation_id);
    const rows = await client.query<{
      claim_ordinal: number;
      confirmation: MemoryConfirmation;
      attribute_snapshot: string | null;
      content_snapshot: string;
      evidence_kind: ProfileViewClaim["evidenceKind"];
      kind: MemoryKind;
      memory_ref_snapshot: string;
      observed_at: Date;
      origin_label_snapshot: string;
      origin_scope: MemoryScope;
      source_author_label_snapshot: string;
      priority_reason: ProfileSubjectPriority;
      subject_label_snapshot: string;
      subject_ordinal: number;
      subject_ref_snapshot: string;
      subject_total_characters: number;
    }>(
      `SELECT subject.ordinal AS subject_ordinal, subject.subject_ref_snapshot,
              subject.subject_label_snapshot, subject.priority_reason,
              subject.total_characters AS subject_total_characters,
              selected.claim_ordinal, selected.memory_ref_snapshot,
              selected.content_snapshot, selected.kind, selected.confirmation,
              selected.origin_scope, selected.origin_label_snapshot, selected.evidence_kind,
              selected.observed_at, selected.source_author_label_snapshot,
              selected.attribute_snapshot
       FROM profile_view_subjects AS subject
       JOIN profile_view_claims AS selected ON selected.profile_view_id = subject.profile_view_id
         AND selected.subject_ordinal = subject.ordinal
       JOIN memory_items AS claim ON claim.id = selected.claim_id
       LEFT JOIN conversation_participants AS claim_subject
         ON claim_subject.id = claim.subject_participant_id
        WHERE subject.profile_view_id = $1
          AND claim.claim_status = 'active' AND claim.profile_eligible = true
          AND NOT EXISTS (
            SELECT 1 FROM claim_conflicts AS conflict
            WHERE conflict.resolution = 'unresolved'
              AND claim.id IN (conflict.claim_a_id, conflict.claim_b_id)
          )
         AND claim.sensitivity = 'normal' AND claim.kind <> 'episode'
         AND (
         ($2::memory_scope = 'personal' AND (
           (claim.scope = 'personal' AND claim.owner_user_id = $3) OR
           (claim.scope = 'family' AND (claim.subject_user_id = $3 OR claim_subject.linked_user_id = $3)) OR
            ${externalProfileProjectionPredicate({ claimAlias: "claim", viewerUserParameter: "$3" })}
         )) OR
         ($2::memory_scope = 'family' AND claim.scope = 'family') OR
         ($2::memory_scope = 'group' AND claim.scope = 'group' AND claim.group_id = $4)
       )
       ORDER BY subject.ordinal, selected.claim_ordinal`,
      [view.id, conversation.scope, auth.userId, auth.groupId],
    );
    if (rows.rows.length !== view.claim_count) {
      throw new AppError(
        "AGENT_PROFILE_VIEW_ACCESS_CHANGED",
        "Состав или доступ к этому снимку профиля изменился. Создайте новый снимок",
      );
    }
    const subjects = new Map<number, ProfileViewSubject>();
    for (const row of rows.rows) {
      const subject = subjects.get(row.subject_ordinal) ?? {
        claims: [],
        label: row.subject_label_snapshot,
        priority: row.priority_reason,
        subjectRef: row.subject_ref_snapshot,
        totalCharacters: row.subject_total_characters,
      };
      subject.claims.push({
        attribute: row.attribute_snapshot,
        confirmation: row.confirmation,
        content: row.content_snapshot,
        evidenceKind: row.evidence_kind,
        kind: row.kind,
        memoryRef: row.memory_ref_snapshot,
        observedAt: row.observed_at.toISOString(),
        origin: { label: row.origin_label_snapshot, scope: row.origin_scope },
        sourceAuthorLabel: row.source_author_label_snapshot,
      });
      subjects.set(row.subject_ordinal, subject);
    }
    await client.query("COMMIT");
    return {
      generatedAt: view.created_at.toISOString(),
      profileViewRef,
      subjects: [...subjects.values()],
      totalCharacters: view.total_characters,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
