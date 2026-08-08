/**
 * PostgreSQL long-term memory boundary.
 *
 * Exports:
 * - Re-exported memory record and mutation contracts.
 * - `memoryRepository`: transaction-safe scoped CRUD and retrieval operations.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { createMemoryClaim } from "./memory-claim-writer.js";
import { insertClaimEvidence } from "./claim-evidence-writer.js";
import { prepareExplicitClaimEvidence } from "./memory-explicit-claim-evidence.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { memoryListRepository } from "./memory-list-repository.js";
import {
  memoryOperationHash,
  normalizeMemoryClaimContent,
  type MemoryKind,
  type MemoryRow,
  type MemorySensitivity,
  type ReferencedMemoryItem,
  type ReferencedMemoryRow,
  rowToReferencedMemory,
} from "./memory-record.js";

export type {
  CreateMemoryEvidenceInput,
  CreateMemoryInput,
  MemoryConfirmation,
  MemoryEmbeddingStatus,
  MemoryKind,
  MemorySensitivity,
  ReferencedMemoryItem,
} from "./memory-record.js";

interface MutationOperationRow {
  input_hash: string;
  memory_item_id: string | null;
  mutation_kind: "create" | "delete" | "update";
}

interface MutationMemoryRow extends ReferencedMemoryRow {
  group_id: string | null;
  memory_project_id: string | null;
  origin_conversation_id: string | null;
  owner_user_id: string | null;
  profile_eligible: boolean;
  subject_conversation_id: string | null;
  subject_family_id: string | null;
  subject_label: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
}

function requireScope(auth: MemoryAuthorization, scope: MemoryScope): void {
  if (!auth.scopes.includes(scope)) {
    throw new AppError("AGENT_MEMORY_SCOPE_DENIED", "Эта информация недоступна в текущем чате");
  }
  if (scope === "personal" && !auth.userId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить владельца личной памяти");
  }
  if (scope === "group" && !auth.groupId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить группу памяти");
  }
}

async function existingOperation(
  client: PoolClient,
  auth: MemoryAuthorization,
  operationKey: string,
  mutationKind: MutationOperationRow["mutation_kind"],
  inputHash: string,
): Promise<MutationOperationRow | null> {
  const result = await client.query<MutationOperationRow>(
    `SELECT mutation_kind, input_hash, memory_item_id
     FROM memory_mutation_operations
     WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, operationKey],
  );
  const operation = result.rows[0];
  if (!operation) return null;
  if (operation.mutation_kind !== mutationKind || operation.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_MEMORY_REPLAY_MISMATCH",
      "Повтор операции памяти не совпадает с исходным запросом",
    );
  }
  return operation;
}

async function selectAuthorizedMemoryByRef(
  client: PoolClient,
  auth: MemoryAuthorization,
  memoryRef: string,
  lock = false,
): Promise<MutationMemoryRow | null> {
  // Scope predicates run in the same lookup that resolves the opaque ref to an internal UUID.
  const result = await client.query<MutationMemoryRow>(
    `SELECT item.id, item.author_user_id, item.author_telegram_user_id, item.scope, item.kind,
            item.content, item.source, item.confirmation, item.sensitivity, item.message_thread_id,
             item.embedding_status, item.created_at, item.updated_at, ref.memory_ref,
             item.owner_user_id, item.group_id, item.origin_conversation_id,
             item.subject_family_id, item.subject_user_id, item.subject_participant_id,
             item.subject_conversation_id, item.subject_label, item.memory_project_id,
             item.profile_eligible
     FROM memory_item_refs AS ref
     JOIN memory_items AS item ON item.id = ref.memory_item_id
     WHERE ref.memory_ref = $1
       AND item.family_id = $2
       AND (
         (item.scope = 'personal' AND 'personal' = ANY($3::memory_scope[]) AND item.owner_user_id = $4) OR
         (item.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
         (item.scope = 'group' AND 'group' = ANY($3::memory_scope[]) AND item.group_id = $5)
       )
     ${lock ? "FOR UPDATE OF item" : ""}`,
    [memoryRef, auth.familyId, auth.scopes, auth.userId, auth.groupId],
  );
  return result.rows[0] ?? null;
}

async function selectAuthorizedMemoryById(
  client: PoolClient,
  auth: MemoryAuthorization,
  memoryItemId: string,
  lock = false,
): Promise<MutationMemoryRow | null> {
  const result = await client.query<MutationMemoryRow>(
    `SELECT item.id, item.author_user_id, item.author_telegram_user_id, item.scope, item.kind,
            item.content, item.source, item.confirmation, item.sensitivity, item.message_thread_id,
             item.embedding_status, item.created_at, item.updated_at, ref.memory_ref,
             item.owner_user_id, item.group_id, item.origin_conversation_id,
             item.subject_family_id, item.subject_user_id, item.subject_participant_id,
             item.subject_conversation_id, item.subject_label, item.memory_project_id,
             item.profile_eligible
     FROM memory_items AS item
     JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
     WHERE item.id = $1 AND item.family_id = $2 AND (
       (item.scope = 'personal' AND 'personal' = ANY($3::memory_scope[]) AND item.owner_user_id = $4) OR
       (item.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
       (item.scope = 'group' AND 'group' = ANY($3::memory_scope[]) AND item.group_id = $5)
     ) ${lock ? "FOR UPDATE OF item" : ""}`,
    [memoryItemId, auth.familyId, auth.scopes, auth.userId, auth.groupId],
  );
  return result.rows[0] ?? null;
}

async function isCurrentFamilyOwner(
  client: PoolClient,
  auth: MemoryAuthorization,
): Promise<boolean> {
  if (!auth.userId) return false;
  const result = await client.query(
    `SELECT 1 FROM family_memberships
     WHERE family_id = $1 AND user_id = $2 AND role = 'owner'`,
    [auth.familyId, auth.userId],
  );
  return Boolean(result.rowCount);
}

async function isCurrentFamilyMember(
  client: PoolClient,
  auth: MemoryAuthorization,
): Promise<boolean> {
  if (!auth.userId) return false;
  const result = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  return Boolean(result.rowCount);
}

async function requireMutationAccess(
  client: PoolClient,
  auth: MemoryAuthorization,
  memory: MemoryRow,
): Promise<void> {
  requireScope(auth, memory.scope);

  // Personal and family writes require active membership; stale session snapshots cannot mutate data.
  const currentMember = await isCurrentFamilyMember(client, auth);
  const currentOwner = await isCurrentFamilyOwner(client, auth);
  const allowed =
    (memory.scope === "personal" && currentMember && memory.author_user_id === auth.userId) ||
    (memory.scope === "family" &&
      currentMember &&
      (memory.author_user_id === auth.userId || currentOwner)) ||
    (memory.scope === "group" &&
      (memory.author_telegram_user_id === auth.telegramUserId || currentOwner));
  if (!allowed) {
    throw new AppError(
      "AGENT_MEMORY_MUTATION_DENIED",
      "Эту запись может изменить только её автор или владелец семьи",
    );
  }
}

export const memoryRepository = {
  create: createMemoryClaim,

  async deleteByRef(
    auth: MemoryAuthorization,
    memoryRef: string,
    operationKey: string,
  ): Promise<{ deleted: true }> {
    const inputHash = memoryOperationHash({ memoryRef });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await existingOperation(client, auth, operationKey, "delete", inputHash);
      if (replay) {
        await client.query("COMMIT");
        return { deleted: true };
      }
      const memory = await selectAuthorizedMemoryByRef(client, auth, memoryRef, true);
      if (!memory) {
        throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти не найдена");
      }
      await requireMutationAccess(client, auth, memory);

      // Persist idempotency and audit before physical deletion nulls the operation reference.
      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, memory_item_id)
         VALUES ($1, $2, 'delete', $3, $4)`,
        [auth.familyId, operationKey, inputHash, memory.id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'memory.deleted', $3,
                 jsonb_build_object('scope', $4::text, 'kind', $5::text))`,
        [auth.familyId, auth.userId, memory.id, memory.scope, memory.kind],
      );
      await client.query("DELETE FROM memory_items WHERE id = $1", [memory.id]);
      await client.query("COMMIT");
      return { deleted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  list: memoryListRepository.list,

  async updateByRef(
    auth: MemoryAuthorization,
    input: {
      content: string;
      kind?: MemoryKind;
      memoryRef: string;
      operationKey: string;
      sensitivity?: MemorySensitivity;
      source: { conversationId: string; timelineEntryId: string };
    },
  ): Promise<ReferencedMemoryItem> {
    const inputHash = memoryOperationHash(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await existingOperation(client, auth, input.operationKey, "update", inputHash);
      if (replay?.memory_item_id) {
        const replayed = await selectAuthorizedMemoryById(client, auth, replay.memory_item_id, true);
        if (!replayed) {
          throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти уже удалена");
        }
        await requireMutationAccess(client, auth, replayed);
        await client.query("COMMIT");
        return rowToReferencedMemory(replayed);
      }
      const memory = await selectAuthorizedMemoryByRef(client, auth, input.memoryRef, true);
      if (!memory) {
        throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти не найдена");
      }
      await requireMutationAccess(client, auth, memory);
      const correctionKind = input.kind ?? memory.kind;
      const correctionSensitivity = input.sensitivity ?? memory.sensitivity;
      const explicitPrepared = await prepareExplicitClaimEvidence(client, auth, {
        confirmation: "user_confirmed",
        content: input.content,
        explicitSource: input.source,
        kind: correctionKind,
        operationKey: input.operationKey,
        scope: memory.scope,
        sensitivity: correctionSensitivity,
        source: "explicit_correction",
      }, null);
      const primarySource = explicitPrepared.sources[0]!;
      const prepared = {
        ...explicitPrepared,
        evidenceKind: (memory.subject_participant_id !== null &&
          memory.subject_participant_id !== primarySource.authorParticipantId) ||
          (memory.subject_user_id !== null && memory.subject_user_id !== primarySource.authorUserId)
          ? "reported" as const
          : "firsthand" as const,
        subjectConversationId: memory.subject_conversation_id,
        subjectLabel: memory.subject_label,
        subjectParticipantId: memory.subject_participant_id,
        subjectUserId: memory.subject_user_id,
      };
      const result = await client.query<Omit<ReferencedMemoryRow, "memory_ref">>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, group_id, author_user_id, author_telegram_user_id,
            scope, kind, content, source, source_event_id, message_thread_id, confirmation,
             sensitivity, operation_key, provenance_state, origin_conversation_id,
             subject_family_id, subject_user_id, subject_participant_id, subject_conversation_id,
             subject_label, memory_project_id, save_approved, endorsed_by_user_id, endorsed_at,
             content_normalized, profile_eligible)
          SELECT family_id, owner_user_id, group_id, $2, $3, scope, COALESCE($4, kind), $5,
                  'explicit_correction', $9, $10, 'user_confirmed',
                  COALESCE($6, sensitivity), $7, 'evidenced', $11,
                 subject_family_id, subject_user_id, subject_participant_id,
                 subject_conversation_id, subject_label, memory_project_id, true, $2,
                 CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,
                  $8,
                  profile_eligible AND COALESCE($6, sensitivity) = 'normal'
         FROM memory_items WHERE id = $1 AND claim_status = 'active'
         RETURNING id, author_user_id, author_telegram_user_id, scope, kind, content, source,
                   confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at`,
        [memory.id, auth.userId, memory.scope === "group" ? auth.telegramUserId : null,
          input.kind ?? null, input.content, input.sensitivity ?? null, input.operationKey,
           normalizeMemoryClaimContent(input.content), primarySource.sourceMessageId,
           primarySource.messageThreadId, prepared.conversationId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError("AGENT_MEMORY_UPDATE_FAILED", "Не удалось обновить запись памяти");
      }

      const reference = await client.query<{ memory_ref: string }>(
        "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
        [row.id],
      );
      const memoryRef = reference.rows[0]?.memory_ref;
      if (!memoryRef) {
        throw new AppError(
          "AGENT_MEMORY_REF_CREATE_FAILED",
          "Не удалось создать безопасную ссылку на исправленную запись памяти",
        );
      }
      await insertClaimEvidence(client, row.id, prepared);
      // Thread role/order follows the corrected version before retiring the old source.
      await client.query(
        `INSERT INTO memory_thread_entries
           (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
         SELECT thread_id, family_id, scope, scope_partition_key, $2, role, occurred_at
         FROM memory_thread_entries WHERE source_claim_id = $1
         ON CONFLICT (thread_id, source_claim_id, source_outcome_id) DO NOTHING`,
        [memory.id, row.id],
      );
      await client.query(
        `INSERT INTO claim_relations
           (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
            relation_type, detection_method)
         SELECT id, $2, family_id, scope, scope_partition_key, 'correction', 'user_explicit'
         FROM memory_items WHERE id = $1`,
        [memory.id, row.id],
      );
      await client.query(
        `UPDATE memory_items SET claim_status = 'superseded', superseded_by = $2,
                duplicate_of = NULL, updated_at = now() WHERE id = $1`,
        [memory.id, row.id],
      );

      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, memory_item_id)
         VALUES ($1, $2, 'update', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, row.id],
      );
      await client.query(
        `INSERT INTO memory_embedding_jobs (memory_item_id, status, attempts, updated_at)
         VALUES ($1, 'pending', 0, now())
         ON CONFLICT (memory_item_id) DO NOTHING`,
        [row.id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'memory.updated', $3,
                 jsonb_build_object('scope', $4::text, 'kind', $5::text, 'sensitivity', $6::text))`,
        [auth.familyId, auth.userId, row.id, row.scope, row.kind, row.sensitivity],
      );
      await client.query("COMMIT");
      return rowToReferencedMemory({ ...row, memory_ref: memoryRef });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
