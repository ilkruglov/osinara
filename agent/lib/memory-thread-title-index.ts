/**
 * Thread title vectors of the current embedding model.
 *
 * Export:
 * - `memoryThreadTitleIndexRepository.listStale`: threads whose title vector is missing or belongs
 *   to another model, oldest first.
 * - `memoryThreadTitleIndexRepository.save`: stores a title vector unless the title changed or a
 *   current vector already exists.
 *
 * Key construct:
 * - A title gets its vector at creation; after a model change the embedding worker refills them
 *   all, otherwise thread activation and creation would fall back to the purpose text only.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import { memoryVectorLiteral } from "./memory-vector.js";

export interface StaleThreadTitle {
  id: string;
  title: string;
}

export const memoryThreadTitleIndexRepository = {
  async listStale(limit: number, exclude: readonly string[] = []): Promise<StaleThreadTitle[]> {
    const result = await database().query<StaleThreadTitle>(
      `SELECT id, title FROM memory_threads
       WHERE title_embedding_model IS DISTINCT FROM $1 AND NOT (id = ANY($3::uuid[]))
       ORDER BY created_at, id
       LIMIT $2`,
      [MEMORY_EMBEDDING_MODEL_VERSION, limit, exclude],
    );
    return result.rows;
  },

  async save(id: string, title: string, embedding: readonly number[]): Promise<boolean> {
    const vector = memoryVectorLiteral(embedding, () => new AppError(
      "AGENT_MEMORY_THREAD_TITLE_EMBEDDING_INVALID",
      "Не удалось построить смысловой индекс названия нити памяти",
    ));
    const result = await database().query(
      `UPDATE memory_threads SET title_embedding = $3::vector, title_embedding_model = $4
       WHERE id = $1 AND title = $2 AND title_embedding_model IS DISTINCT FROM $4`,
      [id, title, vector, MEMORY_EMBEDDING_MODEL_VERSION],
    );
    return result.rowCount === 1;
  },
};
