/**
 * Deterministic memory extraction candidate identity tests.
 *
 * Constructs covered:
 * - `memoryExtractionCandidateId`: application-owned identity over canonical candidate data.
 * - `memoryExtractionOperationKey`: batch- and schema-bound claim operation identity.
 */
import { describe, expect, it } from "vitest";

import {
  memoryExtractionCandidateId,
  memoryExtractionOperationKey,
} from "./memory-extraction-candidate.js";

const SCHEMA_VERSION = "memory-candidate-v1";

describe("memory extraction candidate identity", () => {
  it("distinguishes multiple atomic candidates from the same primary source", () => {
    const source = {
      evidenceKind: "firsthand" as const,
      kind: "fact" as const,
      primarySnapshotEntryId: "10000000-0000-4000-8000-000000000001",
      sensitivity: "normal" as const,
      supportingSnapshotEntryIds: [] as const,
    };

    const first = memoryExtractionCandidateId({
      ...source,
      content: "Анна работает из дома по вторникам.",
    }, SCHEMA_VERSION);
    const second = memoryExtractionCandidateId({
      ...source,
      content: "Анна предпочитает встречи после обеда.",
    }, SCHEMA_VERSION);

    expect(first).toMatch(/^cand_[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);
  });

  it("is independent of model object key order and binds operation keys to batch and schema", () => {
    const candidate = {
      content: "Семья планирует поездку в Казань летом.",
      evidenceKind: "reported" as const,
      kind: "episode" as const,
      primarySnapshotEntryId: "10000000-0000-4000-8000-000000000002",
      sensitivity: "normal" as const,
      supportingSnapshotEntryIds: ["10000000-0000-4000-8000-000000000001"],
    };
    const candidateId = memoryExtractionCandidateId(candidate, SCHEMA_VERSION);

    expect(memoryExtractionCandidateId({ ...candidate }, SCHEMA_VERSION)).toBe(candidateId);
    expect(memoryExtractionOperationKey(
      "20000000-0000-4000-8000-000000000001",
      candidateId,
      SCHEMA_VERSION,
    )).toBe(
      `extraction:20000000-0000-4000-8000-000000000001:${candidateId}:${SCHEMA_VERSION}`,
    );
  });
});
