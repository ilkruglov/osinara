/**
 * Thread title vectors after an embedding model change.
 *
 * Constructs covered:
 * - A thread whose vector belongs to another model is listed, a current one is not.
 * - Saving fills the vector once; a changed title or an already current vector is left alone.
 * - Titles that failed in this worker run can be excluded from the listing.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import { memoryThreadTitleIndexRepository } from "./memory-thread-title-index.js";
import {
  createBroadThread,
  createThreadRepositoryFixture,
  THREAD_TITLE_VECTOR,
} from "./memory-thread-repository.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("thread title index", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE memory_threads, memory_projects, memory_items_all, users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("refills a title vector of another model exactly once", async () => {
    const fixture = await createThreadRepositoryFixture();
    await createBroadThread(fixture);
    expect(await memoryThreadTitleIndexRepository.listStale(8)).toEqual([]);

    await database().query("UPDATE memory_threads SET title_embedding = NULL, title_embedding_model = NULL");
    const [stale] = await memoryThreadTitleIndexRepository.listStale(8);
    expect(stale).toEqual({ id: expect.any(String), title: fixture.projectTitle });
    expect(await memoryThreadTitleIndexRepository.listStale(8, [stale!.id])).toEqual([]);

    expect(await memoryThreadTitleIndexRepository.save(stale!.id, "Другое название", THREAD_TITLE_VECTOR))
      .toBe(false);
    expect(await memoryThreadTitleIndexRepository.save(stale!.id, stale!.title, THREAD_TITLE_VECTOR)).toBe(true);
    expect(await memoryThreadTitleIndexRepository.save(stale!.id, stale!.title, THREAD_TITLE_VECTOR)).toBe(false);
    expect(await memoryThreadTitleIndexRepository.listStale(8)).toEqual([]);
    const stored = await database().query<{ model: string }>(
      "SELECT title_embedding_model AS model FROM memory_threads WHERE id = $1", [stale!.id],
    );
    expect(stored.rows[0]?.model).toBe(MEMORY_EMBEDDING_MODEL_VERSION);
  });
});
