/**
 * Transactional memory-thread candidate coordinator shared by online and recovery discovery.
 *
 * Export:
 * - `commitMemoryThreadDecision`: revalidates every source/identity and materializes one idempotent result.
 * - Optional embedding dependency supports isolated coordinator integration tests.
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { MEMORY_EMBEDDING_DIMENSIONS, MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import type { MemoryThreadDecision } from "./memory-thread-classifier.js";
import { validateSubthreadEvidence } from "./memory-thread-discovery-policy.js";

interface JobIdentityRow {
  family_id: string;
  memory_project_id: string | null;
  scope: "family" | "group" | "personal";
  scope_partition_key: string;
  subject_conversation_id: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
}

interface DecisionSourceRow {
  extraction_batch_id: string | null;
  id: string;
  kind: "episode" | "fact" | "family_shared" | "preference" | "profile";
  role: string;
  source_ref: string;
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS ||
    !vector.every((value) => Number.isFinite(value))) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_TITLE_EMBEDDING_INVALID",
      "Не удалось построить смысловой индекс названия нити памяти",
    );
  }
  return `[${vector.join(",")}]`;
}

async function resolveDecisionSources(
  client: PoolClient,
  jobId: string,
  decision: MemoryThreadDecision,
): Promise<DecisionSourceRow[]> {
  const roles = new Map(decision.entries.map((entry) => [entry.sourceRef, entry.role]));
  const result = await client.query<Omit<DecisionSourceRow, "role"> & { provenance_state: string }>(
    `SELECT source.source_ref, source.source_claim_id AS id, source.extraction_batch_id,
            item.kind::text, item.provenance_state::text
     FROM memory_thread_discovery_sources AS source
     JOIN memory_items AS item ON item.id = source.source_claim_id
     WHERE source.job_id = $1 AND source.source_ref = ANY($2::text[])
       AND item.claim_status = 'active'
     FOR UPDATE OF item`,
    [jobId, [...roles.keys()]],
  );
  if (result.rows.length !== roles.size || result.rows.some((row) =>
    row.provenance_state !== "evidenced" || !roles.has(row.source_ref)
  )) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_SOURCE_STALE",
      "Источник кандидата нити изменился до сохранения решения",
    );
  }
  return result.rows.map((row) => ({ ...row, role: roles.get(row.source_ref)! }));
}

async function resolveCandidateThread(
  client: PoolClient,
  jobId: string,
  candidateRef: string,
  requireRoot: boolean,
): Promise<{ id: string; memoryProjectId: string | null; parentThreadId: string | null }> {
  const result = await client.query<{
    id: string;
    memory_project_id: string | null;
    parent_thread_id: string | null;
  }>(
    `SELECT thread.id, thread.parent_thread_id, thread.memory_project_id
     FROM memory_thread_discovery_existing AS candidate
     JOIN memory_threads AS thread ON thread.id = candidate.thread_id
     WHERE candidate.job_id = $1 AND candidate.thread_candidate_ref = $2
       AND thread.status = 'active' FOR UPDATE OF thread`,
    [jobId, candidateRef],
  );
  const thread = result.rows[0];
  if (!thread || (requireRoot && thread.parent_thread_id !== null)) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_TARGET_STALE",
      "Выбранная нить памяти больше недоступна для этого решения",
    );
  }
  return {
    id: thread.id,
    memoryProjectId: thread.memory_project_id,
    parentThreadId: thread.parent_thread_id,
  };
}

async function assignProjectIdentity(
  client: PoolClient,
  jobId: string,
  identity: JobIdentityRow,
  projectId: string,
  sourceClaimIds: readonly string[],
): Promise<JobIdentityRow> {
  const assigned = await client.query(
    `UPDATE memory_items SET memory_project_id = $2
     WHERE id = ANY($1::uuid[]) AND subject_user_id IS NULL
       AND subject_participant_id IS NULL AND memory_project_id IS NULL`,
    [sourceClaimIds, projectId],
  );
  if (assigned.rowCount !== sourceClaimIds.length) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_PROJECT_IDENTITY_CONFLICT",
      "Источники проекта уже принадлежат другой проверенной identity",
    );
  }
  await client.query(
    "UPDATE memory_thread_discovery_jobs SET memory_project_id = $2 WHERE id = $1",
    [jobId, projectId],
  );
  return { ...identity, memory_project_id: projectId };
}

async function ensureProjectIdentity(
  client: PoolClient,
  jobId: string,
  identity: JobIdentityRow,
  title: string,
  sourceClaimIds: readonly string[],
): Promise<JobIdentityRow> {
  if (identity.memory_project_id) return identity;
  if (identity.subject_user_id || identity.subject_participant_id || identity.scope === "personal") {
    return identity;
  }
  const project = await client.query<{ id: string }>(
    `INSERT INTO memory_projects (family_id, group_id, scope, scope_partition_key, title)
     VALUES ($1, CASE WHEN $2::memory_scope = 'group' THEN $3::uuid ELSE NULL END, $2, $3, $4)
     ON CONFLICT (family_id, scope, scope_partition_key, title_normalized)
     DO UPDATE SET updated_at = memory_projects.updated_at
     RETURNING id`,
    [identity.family_id, identity.scope, identity.scope_partition_key, title],
  );
  return await assignProjectIdentity(
    client,
    jobId,
    identity,
    project.rows[0]!.id,
    sourceClaimIds,
  );
}

async function findDuplicateThread(
  client: PoolClient,
  identity: JobIdentityRow,
  parentThreadId: string | null,
  title: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM memory_threads
     WHERE family_id = $1 AND scope = $2 AND scope_partition_key = $3
       AND subject_user_id IS NOT DISTINCT FROM $4::uuid
       AND subject_participant_id IS NOT DISTINCT FROM $5::uuid
       AND memory_project_id IS NOT DISTINCT FROM $6::uuid
       AND parent_thread_id IS NOT DISTINCT FROM $7::uuid
       AND title_normalized = lower(regexp_replace(trim($8), '\s+', ' ', 'g'))
       AND status = 'active' FOR UPDATE`,
    [identity.family_id, identity.scope, identity.scope_partition_key, identity.subject_user_id,
      identity.subject_participant_id, identity.memory_project_id, parentThreadId, title],
  );
  return result.rows[0]?.id ?? null;
}

export async function commitMemoryThreadDecision(
  jobId: string,
  leaseToken: string,
  decision: MemoryThreadDecision,
  embedTitle: typeof embedMemoryPassages = embedMemoryPassages,
): Promise<void> {
  const titleEmbedding = decision.action === "create_new" || decision.action === "create_subthread"
    ? (await embedTitle([decision.title!]))[0]!
    : null;
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const jobs = await client.query<JobIdentityRow & { id: string }>(
      `SELECT id, family_id, scope, scope_partition_key, subject_user_id,
              subject_participant_id, subject_conversation_id, memory_project_id
       FROM memory_thread_discovery_jobs
       WHERE id = $1 AND status = 'leased' AND lease_token = $2
         AND lease_expires_at > now() AND provider_call_started_at IS NOT NULL
       FOR UPDATE`,
      [jobId, leaseToken],
    );
    const lockedJob = jobs.rows[0];
    if (!lockedJob) {
      throw new AppError("AGENT_MEMORY_THREAD_DISCOVERY_JOB_STALE", "Задача поиска нити уже не арендована");
    }
    let identity: JobIdentityRow = lockedJob;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${identity.family_id}:${identity.scope}:${identity.scope_partition_key}`],
    );
    const sources = await resolveDecisionSources(client, jobId, decision);

    let materializedAction = decision.action;
    let threadId: string | null = null;
    if (decision.action === "attach_existing") {
      const target = await resolveCandidateThread(client, jobId, decision.threadRef!, false);
      if (!identity.subject_user_id && !identity.subject_participant_id &&
        !identity.memory_project_id && target.memoryProjectId) {
        identity = await assignProjectIdentity(
          client,
          jobId,
          identity,
          target.memoryProjectId,
          sources.map((source) => source.id),
        );
      }
      threadId = target.id;
    } else if (decision.action === "create_new" || decision.action === "create_subthread") {
      if (decision.action === "create_subthread") {
        const gate = validateSubthreadEvidence(sources.map((source) => ({
          batchRef: source.extraction_batch_id,
          role: source.role as never,
          sourceKind: source.kind,
        })));
        if (!gate.eligible) materializedAction = "ambiguous";
      }
      if (materializedAction !== "ambiguous") {
        const parent = decision.action === "create_subthread"
          ? await resolveCandidateThread(client, jobId, decision.parentThreadRef!, true)
          : null;
        const parentId = parent?.id ?? null;
        if (!identity.subject_user_id && !identity.subject_participant_id &&
          !identity.memory_project_id && parent?.memoryProjectId) {
          identity = await assignProjectIdentity(
            client,
            jobId,
            identity,
            parent.memoryProjectId,
            sources.map((source) => source.id),
          );
        } else {
          identity = await ensureProjectIdentity(
            client,
            jobId,
            identity,
            decision.title!,
            sources.map((source) => source.id),
          );
        }
        threadId = await findDuplicateThread(client, identity, parentId, decision.title!);
        if (threadId) {
          materializedAction = "attach_existing";
        } else {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO memory_threads
               (family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
                subject_conversation_id, memory_project_id, parent_thread_id, title, purpose,
                title_embedding, title_embedding_model)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12) RETURNING id`,
            [identity.family_id, identity.scope, identity.scope_partition_key,
              identity.subject_user_id, identity.subject_participant_id,
              identity.subject_conversation_id, identity.memory_project_id, parentId,
              decision.title, decision.purpose, vectorLiteral(titleEmbedding!),
              MEMORY_EMBEDDING_MODEL_VERSION],
          );
          threadId = inserted.rows[0]!.id;
          await client.query(
            `INSERT INTO memory_thread_creation_notices (thread_id, family_id) VALUES ($1, $2)`,
            [threadId, identity.family_id],
          );
        }
      }
    }

    // Entry insertion is idempotent and every row is revalidated by the database source trigger.
    if (threadId) {
      for (const source of sources) {
        await client.query(
          `INSERT INTO memory_thread_entries
             (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
           SELECT $1, item.family_id, item.scope, item.scope_partition_key, item.id, $2,
                  COALESCE(evidence.observed_at, item.created_at)
           FROM memory_items AS item
           LEFT JOIN LATERAL (
             SELECT observed_at FROM claim_evidence
             WHERE claim_id = item.id AND evidence_role = 'primary' LIMIT 1
           ) AS evidence ON true
           WHERE item.id = $3
           ON CONFLICT (thread_id, source_claim_id, source_outcome_id) DO NOTHING`,
          [threadId, source.role, source.id],
        );
      }
    }
    await client.query(
      `UPDATE memory_thread_discovery_jobs
       SET status = $3, result_thread_id = $4, output_payload_hash = $5,
           lease_token = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1 AND lease_token = $2`,
      [jobId, leaseToken, materializedAction, threadId, payloadHash({ decision, materializedAction })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
