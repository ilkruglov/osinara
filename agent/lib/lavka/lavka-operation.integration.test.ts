/**
 * Lavka operation ledger (PostgreSQL, migration 118).
 *
 * Constructs covered:
 * - The first begin starts a row, a second begin of the same key sees it with its hash and status.
 * - Complete stores the result once; release frees only a started row.
 * - Keys are per person: the same call key of another person is independent.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase } from "../database.js";
import { createMemoryFamilyFixture } from "../memory-repository.integration-fixtures.js";
import { lavkaOperationRepository } from "./lavka-operation.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const HASH = "a".repeat(64);

describeWithDatabase("lavkaOperationRepository", () => {
  afterAll(closeDatabase);

  it("starts, completes, replays and releases per person", async () => {
    const family = await createMemoryFamilyFixture(`lavka-op-${Date.now()}`);
    const owner = family.owner.userId!;
    const member = family.member.userId!;

    await expect(lavkaOperationRepository.begin({ action: "order", key: "s:c1", requestHash: HASH, userId: owner })).resolves.toEqual({ kind: "started" });
    await expect(lavkaOperationRepository.begin({ action: "order", key: "s:c1", requestHash: HASH, userId: owner })).resolves.toEqual({ kind: "existing", requestHash: HASH, result: null, status: "started" });
    await expect(lavkaOperationRepository.begin({ action: "order", key: "s:c1", requestHash: HASH, userId: member })).resolves.toEqual({ kind: "started" });

    await lavkaOperationRepository.complete({ key: "s:c1", result: { orderId: "o-1" }, userId: owner });
    await lavkaOperationRepository.release({ key: "s:c1", userId: owner });
    await expect(lavkaOperationRepository.begin({ action: "order", key: "s:c1", requestHash: HASH, userId: owner })).resolves.toEqual({ kind: "existing", requestHash: HASH, result: { orderId: "o-1" }, status: "completed" });

    await lavkaOperationRepository.release({ key: "s:c1", userId: member });
    await expect(lavkaOperationRepository.begin({ action: "add", key: "s:c1", requestHash: HASH, userId: member })).resolves.toEqual({ kind: "started" });
  });
});
