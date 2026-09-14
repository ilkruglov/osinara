/**
 * Reinforcement of existing memory records by opaque ref.
 *
 * Export:
 * - `memoryReinforcementRepository.reinforceByRefs`: records turn-idempotent use or reinforcement for active
 *   authorized records. Model use updates only use_count/last_used_at, never evidence recency.
 *
 * Only explicit remember reinforcement widens stability. Neither display nor model use does.
 */
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";

export type MemoryReinforcementReason = "model_used" | "remember_reinforces";

export interface ReinforceByRefsInput {
  memoryRefs: readonly string[];
  provenance: { sessionId: string; turnId: string };
  reason: MemoryReinforcementReason;
}

export interface ReinforceByRefsResult {
  reinforced: string[];
  unknown: string[];
}

export const memoryReinforcementRepository = {
  async reinforceByRefs(auth: MemoryAuthorization, input: ReinforceByRefsInput): Promise<ReinforceByRefsResult> {
    const requested = [...new Set(input.memoryRefs)];
    if (requested.length === 0) return { reinforced: [], unknown: [] };
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // The same scope predicate as model-facing mutations: a ref outside the caller's areas is unknown.
      const rows = await client.query<{ id: string; memory_ref: string }>(
        `SELECT item.id, ref.memory_ref
           FROM memory_item_refs AS ref
           JOIN memory_items AS item ON item.id = ref.memory_item_id
          WHERE ref.memory_ref = ANY($1::text[])
            AND item.family_id = $2 AND item.claim_status = 'active' AND item.deleted_at IS NULL
            -- The session's scopes are a snapshot; membership and group ownership are read live,
            -- so a revoked member cannot keep reinforcing (and reading back) family records.
            AND (
              (item.scope = 'personal' AND 'personal' = ANY($3::memory_scope[]) AND item.owner_user_id = $4
                AND EXISTS (SELECT 1 FROM family_memberships WHERE family_id = $2 AND user_id = $4)) OR
              (item.scope = 'family' AND 'family' = ANY($3::memory_scope[])
                AND EXISTS (SELECT 1 FROM family_memberships WHERE family_id = $2 AND user_id = $4)) OR
              (item.scope = 'group' AND 'group' = ANY($3::memory_scope[]) AND item.group_id = $5
                AND EXISTS (SELECT 1 FROM telegram_groups WHERE id = $5 AND family_id = $2))
            )
          ORDER BY item.created_at, item.id
          FOR UPDATE OF item`,
        [requested, auth.familyId, auth.scopes, auth.userId, auth.groupId],
      );
      for (const row of rows.rows) {
        const event = await client.query(
          `INSERT INTO memory_reinforcement_events (memory_item_id, eve_session_id, eve_turn_id, reason)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING memory_item_id`,
          [row.id, input.provenance.sessionId, input.provenance.turnId, input.reason],
        );
        if (!event.rowCount) continue;
        await client.query(
          input.reason === "model_used"
            ? `UPDATE memory_items SET use_count = use_count + 1, last_used_at = now() WHERE id = $1`
            : `UPDATE memory_items
              SET reinforcement_count = reinforcement_count + 1, last_reinforced_at = now(), updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
           VALUES ($1, $2, 'memory.reinforced', $3,
                   jsonb_build_object('reason', $4::text, 'sessionId', $5::text, 'turnId', $6::text))`,
          [auth.familyId, auth.userId, row.id, input.reason, input.provenance.sessionId, input.provenance.turnId],
        );
      }
      await client.query("COMMIT");
      const reinforced = rows.rows.map((row) => row.memory_ref);
      return { reinforced, unknown: requested.filter((ref) => !reinforced.includes(ref)) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
