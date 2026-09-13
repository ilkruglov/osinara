/** Real PostgreSQL reservations prevent parallel photo/document sends of one payload. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createWorkspaceBinaryRepository } from "./workspace-binary-repository.js";
import { createWorkspaceFileDeliveryRepository } from "./workspace-file-delivery-repository.js";
import { createWorkspaceRepository } from "./workspace-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL ?? "http://invalid").pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
let root: string | undefined;

async function fixture() {
  const familyId = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Delivery') RETURNING id",
  )).rows[0]!.id;
  const userId = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Владелец') RETURNING id",
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, userId],
  );
  const auth = { familyId, userId, role: "owner" as const, groupId: null,
    groupType: null, telegramChatType: "private" as const };
  root = await mkdtemp(join(tmpdir(), "delivery-concurrency-"));
  const binaries = createWorkspaceBinaryRepository(root, createWorkspaceRepository(root));
  await binaries.writeBinary(auth, {
    bytes: Buffer.from("same payload"), mediaType: "text/plain", operationKey: "write",
    path: "out/file.txt", scope: "personal",
  });
  return {
    auth, binaries,
    input: { chatId: "101", path: "out/file.txt", scope: "personal" as const,
      turnId: "eve-session:turn-1", presentation: "document" as const },
  };
}

(enabled ? describe : describe.skip)("workspace delivery reservation concurrency", () => {
  beforeEach(async () => { await database().query("TRUNCATE families, users CASCADE"); });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  afterAll(closeDatabase);

  it("reserves once across concurrent calls and replays the confirmed result", async () => {
    const { auth, binaries, input } = await fixture();
    // Separate repository instances share only PostgreSQL, as separate workers do.
    const repositories = [createWorkspaceFileDeliveryRepository(binaries), createWorkspaceFileDeliveryRepository(binaries)];
    const results = await Promise.allSettled(repositories.map((repository, index) =>
      repository.begin(auth, { ...input, operationKey: `send-${index}`,
        presentation: index === 0 ? "document" : "photo" })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: { code: "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS" } });
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect((await database().query("SELECT status FROM workspace_file_deliveries")).rows)
      .toEqual([{ status: "started" }]);
    await repositories[winner]!.complete(`send-${winner}`, "77");
    await expect(repositories[0]!.begin(auth, { ...input, operationKey: "another-call" }))
      .resolves.toMatchObject({ status: "duplicate", telegramMessageId: "77" });
    await expect(repositories[0]!.begin(auth, { ...input, operationKey: "later-turn", turnId: "eve-session:turn-2" }))
      .resolves.toMatchObject({ status: "reserved" });
  });

  it("keeps a lost receipt ambiguous for a new call in the same turn", async () => {
    const { auth, binaries, input } = await fixture();
    const repository = createWorkspaceFileDeliveryRepository(binaries);
    await repository.begin(auth, { ...input, operationKey: "unconfirmed-send" });
    await expect(repository.begin(auth, { ...input, operationKey: "retry-as-photo", presentation: "photo" }))
      .rejects.toMatchObject({ code: "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS" });
  });

  it("allows a different call after a definitive failure", async () => {
    const { auth, binaries, input } = await fixture();
    const repository = createWorkspaceFileDeliveryRepository(binaries);
    await repository.begin(auth, { ...input, operationKey: "rejected-photo", presentation: "photo" });
    await repository.fail("rejected-photo", "AGENT_WORKSPACE_FILE_TYPE_UNSUPPORTED");
    await expect(repository.begin(auth, { ...input, operationKey: "send-document" }))
      .resolves.toMatchObject({ status: "reserved" });
  });

  it("does not reuse a receipt from another forum topic", async () => {
    const { auth, binaries, input } = await fixture();
    const repository = createWorkspaceFileDeliveryRepository(binaries);
    await repository.begin(auth, { ...input, operationKey: "topic-1", messageThreadId: 1 });
    await repository.complete("topic-1", "77");
    await expect(repository.begin(auth, { ...input, operationKey: "topic-2", messageThreadId: 2 }))
      .resolves.toMatchObject({ status: "reserved" });
    await expect(repository.begin(auth, { ...input, operationKey: "no-topic" }))
      .resolves.toMatchObject({ status: "reserved" });
  });
});
