/**
 * Single transactional writer for ordinary, extracted, and approved memory claims.
 *
 * Export:
 * - `createMemoryClaim`: replay-safe claim/reinforcement, evidence, approval, quota, index, and audit write.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { insertClaimEvidence, prepareClaimEvidence } from "./claim-evidence-writer.js";
import { prepareExplicitClaimEvidence } from "./memory-explicit-claim-evidence.js";
import { database } from "./database.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { reinforceExactClaim } from "./memory-exact-reinforcement.js";
import { enforceMemoryQuota } from "./memory-quota.js";
import type { MemoryConsolidationResolution } from "./memory-consolidation-contract.js";
import { consolidateExplicitMemoryCreate } from "./memory-explicit-consolidation.js";
import {
  memoryOperationHash,
  type CreateMemoryInput,
  type ReferencedMemoryItem,
  type ReferencedMemoryRow,
  rowToReferencedMemory,
  normalizeMemoryClaimContent,
} from "./memory-record.js";

interface CreateOperationRow {
  input_hash: string;
  memory_item_id: string | null;
  mutation_kind: "create" | "delete" | "update";
}

async function lockConsolidationTarget(
  client: PoolClient,
  identity: {
    consolidation: MemoryConsolidationResolution | null;
    familyId: string;
    scope: MemoryScope;
    scopePartitionKey: string;
  },
): Promise<string | null> {
  const consolidation = identity.consolidation;
  if (!consolidation || consolidation.relation === "new") return null;
  if (!consolidation.targetClaimId) {
    throw new AppError(
      "AGENT_MEMORY_CONSOLIDATION_TARGET_MISSING",
      "Завершённая relation не содержит проверенной связанной версии памяти",
    );
  }
  const target = await client.query<{ id: string }>(
    `SELECT id FROM memory_items
     WHERE id = $1 AND family_id = $2 AND scope = $3 AND scope_partition_key = $4
       AND claim_status = 'active' FOR UPDATE`,
    [consolidation.targetClaimId, identity.familyId, identity.scope, identity.scopePartitionKey],
  );
  if (!target.rows[0]) {
    throw new AppError(
      "AGENT_MEMORY_CONSOLIDATION_TARGET_STALE",
      "Связанная версия памяти изменилась; требуется новая явная consolidation attempt",
    );
  }
  return target.rows[0].id;
}

async function applyConsolidationRelation(
  client: PoolClient,
  identity: {
    consolidation: MemoryConsolidationResolution | null;
    familyId: string;
    scope: MemoryScope;
    scopePartitionKey: string;
  },
  newClaimId: string,
  targetClaimId: string | null,
): Promise<void> {
  const relation = identity.consolidation?.relation;
  if (!relation || relation === "new") return;
  if (!targetClaimId) {
    throw new AppError(
      "AGENT_MEMORY_CONSOLIDATION_TARGET_MISSING",
      "Relation потеряла связанную версию памяти",
    );
  }
  if (relation === "conflict") {
    await client.query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3, $4, $5,
               'model_guarded')
       ON CONFLICT (claim_a_id, claim_b_id) DO NOTHING`,
      [newClaimId, targetClaimId, identity.familyId, identity.scope, identity.scopePartitionKey],
    );
    return;
  }
  await client.query(
    `INSERT INTO claim_relations
       (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
        relation_type, detection_method)
     VALUES ($1, $2, $3, $4, $5, $6, 'model_guarded')`,
    [relation === "duplicate" ? newClaimId : targetClaimId,
      relation === "duplicate" ? targetClaimId : newClaimId,
      identity.familyId, identity.scope, identity.scopePartitionKey, relation],
  );
  if (relation !== "duplicate") {
    await client.query(
      `UPDATE memory_items SET claim_status = 'superseded', superseded_by = $2,
              duplicate_of = NULL, updated_at = now() WHERE id = $1 AND claim_status = 'active'`,
      [targetClaimId, newClaimId],
    );
  }
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

async function requireCurrentWriteContext(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
): Promise<void> {
  if (scope !== "group") {
    const member = await client.query(
      "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
      [auth.familyId, auth.userId],
    );
    if (member.rowCount) return;
    throw new AppError("AGENT_ACCESS_DENIED", "Доступ к семейному агенту был отозван");
  }
  const group = await client.query(
    "SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 FOR SHARE",
    [auth.groupId, auth.familyId],
  );
  if (!group.rowCount) {
    throw new AppError("AGENT_GROUP_NOT_REGISTERED", "Эта группа больше не подключена к агенту");
  }
}

async function existingCreate(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
): Promise<ReferencedMemoryRow | null> {
  const operation = await client.query<CreateOperationRow>(
    `SELECT mutation_kind, input_hash, memory_item_id
     FROM memory_mutation_operations WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, input.operationKey],
  );
  const replay = operation.rows[0];
  if (!replay) return null;
  if (replay.mutation_kind !== "create" || replay.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_MEMORY_REPLAY_MISMATCH",
      "Повтор операции памяти не совпадает с исходным запросом",
    );
  }
  if (!replay.memory_item_id) {
    throw new AppError("AGENT_MEMORY_REPLAY_COMPLETED", "Исходная запись памяти уже удалена");
  }
  const result = await client.query<ReferencedMemoryRow>(
    `SELECT item.id, item.author_user_id, item.author_telegram_user_id, item.scope, item.kind,
            item.content, item.source, item.confirmation, item.sensitivity, item.message_thread_id,
            item.embedding_status, item.created_at, item.updated_at, ref.memory_ref
     FROM memory_items AS item
     JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
     WHERE item.id = $1 AND item.family_id = $2 AND (
       (item.scope = 'personal' AND 'personal' = ANY($3::memory_scope[])
         AND item.owner_user_id = $4) OR
       (item.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
       (item.scope = 'group' AND 'group' = ANY($3::memory_scope[]) AND item.group_id = $5)
     )`,
    [replay.memory_item_id, auth.familyId, auth.scopes, auth.userId, auth.groupId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError("AGENT_MEMORY_REPLAY_COMPLETED", "Исходная запись памяти уже удалена");
  return row;
}

export async function createMemoryClaim(
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  approvalActor?: MemoryAuthorization,
): Promise<ReferencedMemoryItem> {
  requireScope(auth, input.scope);
  if (input.evidence && input.explicitSource) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_INPUT_INVALID",
      "Одна запись памяти не может одновременно иметь extraction и explicit source",
    );
  }
  const explicitConsolidation = input.evidence
    ? null
    : await consolidateExplicitMemoryCreate(auth, input);
  const inputHash = memoryOperationHash(input);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const replay = await existingCreate(client, auth, input, inputHash);
    if (replay) {
      await client.query("COMMIT");
      return rowToReferencedMemory(replay);
    }
    await requireCurrentWriteContext(client, auth, input.scope);
    const prepared = input.explicitSource
      ? await prepareExplicitClaimEvidence(client, auth, input, explicitConsolidation)
      : await prepareClaimEvidence(client, auth, input, approvalActor);
    const ownerUserId = input.scope === "personal" ? auth.userId : null;
    const groupId = input.scope === "group" ? auth.groupId : null;
    const authorUserId = prepared?.primaryAuthorUserId ?? auth.userId;
    if (input.scope !== "group" && !authorUserId) {
      throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить автора памяти");
    }
    const scopePartitionKey = input.scope === "personal"
      ? auth.userId!
      : input.scope === "group"
        ? auth.groupId!
        : auth.familyId;
    const contentNormalized = prepared?.contentNormalized ?? normalizeMemoryClaimContent(input.content);
    const consolidation = prepared?.consolidation ?? explicitConsolidation;
    const reinforced = await reinforceExactClaim(client, auth, inputHash, {
      contentNormalized,
      operationKey: input.operationKey,
      prepared,
      scope: input.scope,
      scopePartitionKey,
      subjectLabel: prepared?.subjectLabel ?? null,
      subjectParticipantId: prepared?.subjectParticipantId ?? null,
      subjectUserId: prepared?.subjectUserId ?? null,
    });
    if (reinforced) {
      await client.query("COMMIT");
      return rowToReferencedMemory(reinforced);
    }

    const consolidationIdentity = {
      consolidation,
      familyId: auth.familyId,
      scope: input.scope,
      scopePartitionKey,
    };
    const consolidationTarget = await lockConsolidationTarget(client, consolidationIdentity);

    await enforceMemoryQuota(client, auth, input.scope);
    const approved = prepared?.approval ?? null;
    const endorsedByUserId = prepared?.sourceKind === "explicit"
      ? prepared.primaryAuthorUserId
      : approved?.actorUserId ?? null;
    const result = await client.query<Omit<ReferencedMemoryRow, "memory_ref">>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, group_id, author_user_id, author_telegram_user_id,
          scope, kind, content, source, source_event_id, message_thread_id, confirmation,
          sensitivity, operation_key, origin_conversation_id, subject_participant_id,
          subject_conversation_id, subject_user_id, subject_label, save_approved,
           endorsed_by_user_id, endorsed_at, provenance_state, content_normalized, profile_eligible,
           claim_status, duplicate_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20, $21,
                CASE WHEN $21::uuid IS NULL THEN NULL ELSE now() END, $22, $23, $24, $25, $26)
       RETURNING id, author_user_id, author_telegram_user_id, scope, kind, content, source,
                 confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at`,
      [auth.familyId, ownerUserId, groupId, authorUserId,
        prepared?.primaryAuthorTelegramUserId ?? (input.scope === "group" ? auth.telegramUserId : null),
        input.scope, input.kind, input.content, input.source, input.sourceEventId ?? null,
        input.messageThreadId ?? null, input.confirmation, input.sensitivity, input.operationKey,
        prepared?.conversationId ?? null, prepared?.subjectParticipantId ?? null,
        prepared?.subjectConversationId ?? null, prepared?.subjectUserId ?? null,
        prepared?.subjectLabel ?? null, prepared === null ? null : input.confirmation === "user_confirmed",
        endorsedByUserId, prepared === null ? "legacy_unresolved" : "evidenced",
         contentNormalized,
         prepared !== null && input.sensitivity === "normal" &&
           (prepared.subjectUserId !== null || prepared.subjectParticipantId !== null) &&
           consolidation?.relation !== "duplicate",
         consolidation?.relation === "duplicate" ? "duplicate" : "active",
         consolidation?.relation === "duplicate" ? consolidationTarget : null],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("AGENT_MEMORY_WRITE_FAILED", "Не удалось сохранить запись памяти");
    if (prepared !== null) await insertClaimEvidence(client, row.id, prepared);
    await applyConsolidationRelation(
      client,
      consolidationIdentity,
      row.id,
      consolidationTarget,
    );

    const reference = await client.query<{ memory_ref: string }>(
      "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
      [row.id],
    );
    const memoryRef = reference.rows[0]?.memory_ref;
    if (!memoryRef) {
      throw new AppError(
        "AGENT_MEMORY_REF_CREATE_FAILED",
        "Не удалось создать безопасную ссылку на запись памяти",
      );
    }
    await client.query(
      `INSERT INTO memory_mutation_operations
         (family_id, operation_key, mutation_kind, input_hash, memory_item_id)
       VALUES ($1, $2, 'create', $3, $4)`,
      [auth.familyId, input.operationKey, inputHash, row.id],
    );
    await client.query("INSERT INTO memory_embedding_jobs (memory_item_id) VALUES ($1)", [row.id]);
    await client.query(
      `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'memory.created', $3,
               jsonb_build_object('scope', $4::text, 'kind', $5::text, 'sensitivity', $6::text))`,
      [auth.familyId, prepared?.auditActorUserId ?? auth.userId, row.id,
        input.scope, input.kind, input.sensitivity],
    );
    await client.query("COMMIT");
    return rowToReferencedMemory({ ...row, memory_ref: memoryRef });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
