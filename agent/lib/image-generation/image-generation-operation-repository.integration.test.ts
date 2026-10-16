/**
 * Subscription image generation operation ledger integration tests.
 *
 * Constructs covered:
 * - One operation key reserves exactly one billable generation attempt.
 * - Completed results replay without another provider call.
 * - Input drift and ambiguous outcomes fail closed.
 * - Workspace deletion keeps the billing ledger tombstone.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { imageGenerationOperationRepository } from "./image-generation-operation-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const FILE = {
  byteSize: 12,
  contentSha256: "b".repeat(64),
  mediaType: "image/webp",
  path: "generated-images/image-ledger.webp",
  scope: "group" as const,
  updatedAt: "2026-08-21T00:00:00.000Z",
};

async function workspace(): Promise<string> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Image generation') RETURNING id",
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, '-100-image-ledger', 'Image group', 'external', 'all', ARRAY['generate_image'])
     RETURNING id`,
    [family.rows[0]!.id],
  );
  const result = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, group_id, scope) VALUES ($1, $2, 'group') RETURNING id",
    [family.rows[0]!.id, group.rows[0]!.id],
  );
  return result.rows[0]!.id;
}

describeWithDatabase("image generation operation repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE image_generation_operations, telegram_groups, workspaces, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("reserves once and replays the completed file", async () => {
    const workspaceId = await workspace();
    const input = {
      inputHash: "a".repeat(64),
      operationKey: "image-call-1",
      outputPath: FILE.path,
      workspaceId,
    };

    await expect(imageGenerationOperationRepository.begin(input)).resolves.toEqual({
      state: "execute",
      workspaceId,
    });
    await imageGenerationOperationRepository.complete(input.operationKey, FILE);
    await expect(imageGenerationOperationRepository.begin(input)).resolves.toEqual({
      file: FILE,
      state: "completed",
    });
  });

  it("remembers the provider job of a started operation for reconciliation", async () => {
    const workspaceId = await workspace();
    await imageGenerationOperationRepository.begin({ inputHash: "c".repeat(64), operationKey: "image-call-job", outputPath: FILE.path, workspaceId });
    await imageGenerationOperationRepository.recordProviderJob("image-call-job", { jobId: "cmvbdeekj0073zx013f2euglr", model: "nano-banana-2", provider: "plusvibe" });
    await imageGenerationOperationRepository.markAmbiguous("image-call-job", "AGENT_IMAGE_GENERATION_AMBIGUOUS");
    const settled = await database().query<{ provider: string | null; provider_job_id: string | null; provider_model: string | null }>(
      "SELECT provider, provider_job_id, provider_model FROM image_generation_operations WHERE operation_key = 'image-call-job'",
    );
    expect(settled.rows[0]).toEqual({ provider: "plusvibe", provider_job_id: "cmvbdeekj0073zx013f2euglr", provider_model: "nano-banana-2" });
    // A settled operation keeps the job it had: a late report never rewrites history.
    await imageGenerationOperationRepository.recordProviderJob("image-call-job", { jobId: "late", model: "x", provider: "y" });
    const again = await database().query<{ provider_job_id: string | null }>(
      "SELECT provider_job_id FROM image_generation_operations WHERE operation_key = 'image-call-job'",
    );
    expect(again.rows[0]!.provider_job_id).toBe("cmvbdeekj0073zx013f2euglr");
  });

  it("rejects operation-key reuse with different generation input", async () => {
    const workspaceId = await workspace();
    await imageGenerationOperationRepository.begin({
      inputHash: "a".repeat(64),
      operationKey: "image-call-mismatch",
      outputPath: FILE.path,
      workspaceId,
    });

    await expect(imageGenerationOperationRepository.begin({
      inputHash: "c".repeat(64),
      operationKey: "image-call-mismatch",
      outputPath: FILE.path,
      workspaceId,
    })).rejects.toThrowError(/AGENT_IMAGE_GENERATION_REPLAY_MISMATCH/u);
  });

  it("keeps an ambiguous charge terminal", async () => {
    const workspaceId = await workspace();
    const input = {
      inputHash: "d".repeat(64),
      operationKey: "image-call-ambiguous",
      outputPath: FILE.path,
      workspaceId,
    };
    await imageGenerationOperationRepository.begin(input);
    await imageGenerationOperationRepository.markAmbiguous(
      input.operationKey,
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    );

    await expect(imageGenerationOperationRepository.begin(input)).resolves.toEqual({
      errorCode: "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      state: "ambiguous",
    });
  });

  it("keeps a terminal operation after its workspace is deleted", async () => {
    const workspaceId = await workspace();
    const input = {
      inputHash: "e".repeat(64),
      operationKey: "image-call-retired-workspace",
      outputPath: FILE.path,
      workspaceId,
    };
    await imageGenerationOperationRepository.begin(input);
    await imageGenerationOperationRepository.markAmbiguous(
      input.operationKey,
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    );

    await database().query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);

    const ledger = await database().query(
      "SELECT 1 FROM image_generation_operations WHERE operation_key = $1",
      [input.operationKey],
    );
    expect(ledger.rowCount).toBe(1);
  });
});
