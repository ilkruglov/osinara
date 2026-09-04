/**
 * Repeat-task hints: one row per conversation, consumed by the next turn's context.
 *
 * Exports:
 * - `SKILL_HINT_MIN_STEPS`, `SKILL_HINT_IGNORED_TOOLS`, `SKILL_HINT_TTL_MILLISECONDS`.
 * - `skillHintRepository.save` / `take`: upsert after a heavy turn, read-and-delete before the next.
 * - `formatSkillHint`: the single context line the model sees.
 *
 * Key construct:
 * - The application decides when a task looked repeatable (tool-call count); the model only
 *   phrases the offer. Without a row the model has no reason to bring skills up.
 */
import { database } from "../database.js";

export const SKILL_HINT_MIN_STEPS = 4;
export const SKILL_HINT_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;
/** Bookkeeping calls that every turn makes; they say nothing about the task being repeatable. */
export const SKILL_HINT_IGNORED_TOOLS: ReadonlySet<string> = new Set([
  "get_current_time", "list_memories", "load_skill", "manage_skill", "read_profile_view",
  "remember", "search_memories", "search_memory_threads", "list_memory_threads", "read_memory_thread",
]);

export interface SkillHint {
  stepCount: number;
  toolNames: readonly string[];
}

export function formatSkillHint(hint: SkillHint): string {
  return [
    `Предыдущая задача в этом чате потребовала ${hint.stepCount} шагов инструментов: ${hint.toolNames.join(", ")}.`,
    "Если такая задача будет повторяться, предложи сохранить её как навык одной фразой; без ответа не настаивай.",
  ].join(" ");
}

export const skillHintRepository = {
  async save(input: {
    conversationId: string;
    eveSessionId: string;
    eveTurnId: string;
    familyId: string;
    stepCount: number;
    toolNames: readonly string[];
  }): Promise<void> {
    await database().query(
      `INSERT INTO conversation_skill_hints
         (conversation_id, family_id, step_count, tool_names, eve_session_id, eve_turn_id, created_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6, now())
       ON CONFLICT (conversation_id) DO UPDATE
         SET step_count = EXCLUDED.step_count, tool_names = EXCLUDED.tool_names,
             eve_session_id = EXCLUDED.eve_session_id, eve_turn_id = EXCLUDED.eve_turn_id,
             created_at = now()`,
      [input.conversationId, input.familyId, input.stepCount, [...input.toolNames],
        input.eveSessionId, input.eveTurnId],
    );
  },

  /** Returns and removes the pending hint; a stale one is removed without being shown. */
  async take(conversationId: string, now: Date = new Date()): Promise<SkillHint | null> {
    const result = await database().query<{ created_at: Date; step_count: number; tool_names: string[] }>(
      `DELETE FROM conversation_skill_hints WHERE conversation_id = $1
       RETURNING step_count, tool_names, created_at`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (now.getTime() - row.created_at.getTime() > SKILL_HINT_TTL_MILLISECONDS) return null;
    return { stepCount: row.step_count, toolNames: row.tool_names };
  },
};
