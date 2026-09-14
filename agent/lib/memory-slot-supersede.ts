/**
 * Slot-based claim versioning.
 *
 * Export:
 * - `supersedeSlotClaims`: retires older active claims of the same subject and attribute slot.
 */
import type { PoolClient } from "pg";
import { MEMORY_LIST_MAX_LIMIT, MEMORY_SEMANTIC_KINDS } from "./memory-config.js";

import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { ModelFacingError } from "./model-facing-error.js";
import type { CreateMemoryInput, MemoryKind } from "./memory-record.js";

export interface SlotSupersedeInput {
  attribute: string;
  newClaimId: string;
  previousClaimIds: string[];
  scope: MemoryScope;
  systemActor: boolean;
}

export async function lockSlotClaims(
  client: PoolClient, auth: MemoryAuthorization,
  input: { attribute: string; kind: MemoryKind; scope: MemoryScope; scopePartitionKey: string; subjectLabel: string | null; subjectParticipantId: string | null; subjectUserId: string | null; memoryProjectId: string | null },
): Promise<Array<{ id: string; memory_ref: string }>> {
  // Lock the identity before inserting, including an empty slot. Row locks alone miss first-write races.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([
    "memory-slot", auth.familyId, input.scope, input.scopePartitionKey, input.attribute,
    input.kind === "episode" ? "episode" : "semantic", input.subjectLabel,
    input.subjectParticipantId, input.subjectUserId, input.memoryProjectId,
  ])]);
  // The slot is one subject in one partition; a label-only subject is still one slot per label.
  // Semantic kinds share a slot (a "fact" and a "family_shared" about the same thing are one
  // version chain); an episode slot only ever holds episodes.
  const slotKinds = input.kind === "episode" ? ["episode"] : [...MEMORY_SEMANTIC_KINDS];
  const previous = await client.query<{ id: string; memory_ref: string }>(
    `SELECT item.id, ref.memory_ref FROM memory_items AS item
      JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
      WHERE item.family_id = $1 AND item.scope = $2 AND item.scope_partition_key = $3
        AND item.claim_status = 'active' AND item.memory_project_id IS NOT DISTINCT FROM $4::uuid
        AND item.subject_family_id IS NULL
        AND item.attribute = $5 AND item.kind = ANY($6::memory_kind[])
        AND item.subject_participant_id IS NOT DISTINCT FROM $7::uuid
        AND item.subject_user_id IS NOT DISTINCT FROM $8::uuid
        AND item.subject_label IS NOT DISTINCT FROM $9::text
      ORDER BY item.created_at, item.id FOR UPDATE OF item`,
    [auth.familyId, input.scope, input.scopePartitionKey, input.memoryProjectId, input.attribute,
      slotKinds, input.subjectParticipantId, input.subjectUserId, input.subjectLabel],
  );
  return previous.rows;
}

export function requireSlotUpdate(
  rows: readonly { id: string; memory_ref: string }[],
  update: CreateMemoryInput["slotUpdate"],
): string[] {
  const actual = rows.map((row) => row.memory_ref).sort();
  const expected = update?.previousMemoryRefs.slice().sort();
  const code = update ? "AGENT_MEMORY_SLOT_CHANGED" : "AGENT_MEMORY_SLOT_REVIEW_REQUIRED";
  if ((actual.length > 0 && !update) || (update && JSON.stringify(actual) !== JSON.stringify(expected))) {
    throw new ModelFacingError({
      category: "conflict", code, field: "slotUpdate", retryable: false, sideEffectStatus: "not_started",
      reason: update ? "Состав слота изменился после чтения" : "В слоте уже есть активные записи",
      correction: "Прочитай полный текст актуальных записей через list_memories/search_memories. Затем передай slotUpdate с их previousMemoryRefs: add для дополнения, replace для полной новой версии. Текущие ссылки: " + actual.join(", "),
    });
  }
  if (update?.action === "add" && actual.length >= MEMORY_LIST_MAX_LIMIT) {
    throw new ModelFacingError({
      category: "conflict", code: "AGENT_MEMORY_SLOT_LIMIT_REACHED", field: "slotUpdate",
      retryable: false, sideEffectStatus: "not_started", reason: "Достигнут предел отдельных деталей в одном слоте",
      correction: "Собери полную новую версию всех прочитанных записей с action=replace, сохранив актуальные детали.",
    });
  }
  return update?.action === "replace" ? rows.map((row) => row.id) : [];
}

export async function supersedeSlotClaims(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: SlotSupersedeInput,
): Promise<string[]> {
  const ids = input.previousClaimIds;
  for (const previousId of ids) {
    // Thread order follows the newest version, exactly as an explicit correction does.
    await client.query(
      `INSERT INTO memory_thread_entries
         (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
       SELECT thread_id, family_id, scope, scope_partition_key, $2, role, occurred_at
         FROM memory_thread_entries WHERE source_claim_id = $1
       ON CONFLICT (thread_id, source_claim_id, source_outcome_id) DO NOTHING`,
      [previousId, input.newClaimId],
    );
    await client.query(
      `INSERT INTO claim_relations
         (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
          relation_type, detection_method, detection_metadata)
       SELECT id, $2, family_id, scope, scope_partition_key, 'temporal_update',
              'deterministic_exact', jsonb_build_object('method', 'slot_attribute', 'attribute', $3::text)
         FROM memory_items WHERE id = $1`,
      [previousId, input.newClaimId, input.attribute],
    );
    await client.query(
      `UPDATE memory_items SET claim_status = 'superseded', superseded_by = $2,
              duplicate_of = NULL, updated_at = now() WHERE id = $1`,
      [previousId, input.newClaimId],
    );
    await client.query(
      `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'memory.superseded', $3,
               jsonb_build_object('scope', $4::text, 'attribute', $5::text, 'supersededBy', $6::text))`,
      [auth.familyId, input.systemActor ? null : auth.userId, previousId, input.scope,
        input.attribute, input.newClaimId],
    );
  }
  return ids;
}
