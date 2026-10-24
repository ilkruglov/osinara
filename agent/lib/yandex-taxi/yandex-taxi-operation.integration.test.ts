/**
 * Yandex Go operation ledger (PostgreSQL, migration 139).
 *
 * Constructs covered:
 * - The first begin starts a row, a second begin of the same key sees it with its hash and status.
 * - Complete stores the result once; release frees only a started row.
 * - Keys are per person: the same call key of another person is independent.
 * - Someone who is not a member of the family cannot begin an operation.
 */
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase } from "../database.js";
import { createMemoryFamilyFixture } from "../memory-repository.integration-fixtures.js";
import { yandexTaxiOperationRepository } from "./yandex-taxi-operation.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const HASH = "b".repeat(64);

describeWithDatabase("yandexTaxiOperationRepository", () => {
  afterAll(closeDatabase);

  it("starts, completes, replays and releases per person", async () => {
    const family = await createMemoryFamilyFixture(`taxi-op-${Date.now()}`);
    const familyId = family.familyId;
    const owner = family.owner.userId!;
    const member = family.member.userId!;

    await expect(yandexTaxiOperationRepository.begin({ action: "order", familyId, key: "s:c1", requestHash: HASH, userId: owner })).resolves.toEqual({ kind: "started" });
    await expect(yandexTaxiOperationRepository.begin({ action: "order", familyId, key: "s:c1", requestHash: HASH, userId: owner })).resolves.toEqual({ kind: "existing", requestHash: HASH, result: null, status: "started" });
    await expect(yandexTaxiOperationRepository.begin({ action: "order", familyId, key: "s:c1", requestHash: HASH, userId: member })).resolves.toEqual({ kind: "started" });

    await yandexTaxiOperationRepository.complete({ key: "s:c1", result: { orderId: "o-1" }, userId: owner });
    await yandexTaxiOperationRepository.release({ key: "s:c1", userId: owner });
    await expect(yandexTaxiOperationRepository.begin({ action: "order", familyId, key: "s:c1", requestHash: HASH, userId: owner })).resolves.toEqual({ kind: "existing", requestHash: HASH, result: { orderId: "o-1" }, status: "completed" });

    await yandexTaxiOperationRepository.release({ key: "s:c1", userId: member });
    await expect(yandexTaxiOperationRepository.begin({ action: "cancel", familyId, key: "s:c1", requestHash: HASH, userId: member })).resolves.toEqual({ kind: "started" });
  });

  it("refuses someone who is not a member of the family", async () => {
    const family = await createMemoryFamilyFixture(`taxi-op-stranger-${Date.now()}`);
    const other = await createMemoryFamilyFixture(`taxi-op-other-${Date.now()}`);
    await expect(yandexTaxiOperationRepository.begin({ action: "order", familyId: family.familyId, key: `s:${randomUUID()}`, requestHash: HASH, userId: other.owner.userId! }))
      .rejects.toMatchObject({ code: "AGENT_YANDEX_TAXI_ACCESS_DENIED" });
  });
});
