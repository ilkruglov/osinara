/**
 * Outcomes of one person card build.
 *
 * Constructs covered:
 * - An unclear model outcome returns the build to the queue and publishes nothing.
 * - An answer that is not a card, or no records, fails the build.
 * - A lost lease records nothing; a published card passes the switch to the cleanup.
 * - Only a network, timeout or provider-side error is unclear; a rejected request, an exhausted
 *   balance or a truncated answer fails at once, with the transport's code even when wrapped.
 * - A build whose lease was taken does not pay for a model call.
 * - A failure before the model call is named by its stage (lease, retire) and is not paid; from
 *   the model call on a build is possibly paid, unless the provider refused before any work.
 */
import { describe, expect, it, vi } from "vitest";

import { APICallError } from "@ai-sdk/provider";

import { AppError } from "../app-error.js";
import { runPersonCardBuild, type PersonCardBuildDependencies } from "./person-card-builder.js";
import { PersonCardAnswerInterrupted } from "./person-card-generation.js";
import type { ClaimedPersonCardBuild } from "./person-card-dispatch-repository.js";
import type { PersonCardSource } from "./person-card-sources-repository.js";

const build: ClaimedPersonCardBuild = {
  attempts: 1,
  id: "build-1",
  key: { area: "group", areaKey: "group-a", familyId: "family", subjectTelegramUserId: "9402" },
  leaseToken: "lease-1",
  reason: "new_records",
};

const record: PersonCardSource = {
  attribute: null,
  authorLabel: null,
  cleanable: true,
  content: "Любит короткие ответы",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  evidenceKind: "firsthand",
  id: "record-1",
  kind: "preference",
  link: "label",
  memoryRef: "mem_00000000000000000000000000000001",
  occurredAt: null,
  scope: "group",
  scopePartitionKey: "group-a",
  selfStatement: true,
  version: "2026-11-01 00:00:00+00",
};

function dependencies(overrides: Partial<PersonCardBuildDependencies> = {}) {
  const deps: PersonCardBuildDependencies = {
    cleanupEnabled: () => true,
    fail: vi.fn(async () => true),
    generate: vi.fn(async () => ({
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      text: JSON.stringify({
        communication: [{ scope: "всегда", sources: ["r1"], text: "Коротко" }],
      }),
    })),
    loadSources: vi.fn(async () => ({
      episodes: [],
      readIds: [record.id],
      records: [record],
      sourcesAsOf: new Date("2026-11-21T00:00:00Z"),
      subjectLabel: "Юра (yura_k)",
      totalRecords: 1,
    })),
    publish: vi.fn(async () => ({ cardVersion: 1, cleaned: 0, cleanupSkipped: 0 })),
    releaseForRetry: vi.fn(async () => "retry" as const),
    retire: vi.fn(async () => undefined),
    stillLeased: vi.fn(async () => true),
    ...overrides,
  };
  return deps;
}

describe("runPersonCardBuild", () => {
  it("fails at once on a definite model outcome and retries only an unclear one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = async (error: unknown) => {
      const deps = dependencies({
        generate: vi.fn(async () => {
          throw error;
        }),
      });
      await runPersonCardBuild(build, deps);
      return {
        failed: vi.mocked(deps.fail).mock.calls[0]?.[0].errorCode ?? null,
        retried: vi.mocked(deps.releaseForRetry).mock.calls[0]?.[0].errorCode ?? null,
      };
    };
    expect(await outcome(new AppError("AGENT_MODEL_BALANCE_EXHAUSTED", "402"))).toEqual({
      failed: "AGENT_MODEL_BALANCE_EXHAUSTED",
      retried: null,
    });
    expect(await outcome(new AppError("AGENT_MODEL_OUTPUT_TRUNCATED", "length"))).toEqual({
      failed: "AGENT_MODEL_OUTPUT_TRUNCATED",
      retried: null,
    });
    const timeout = new APICallError({
      cause: new AppError("AGENT_MODEL_RESPONSE_TIMEOUT", "silence"),
      message: "timeout",
      requestBodyValues: {},
      url: "https://api.deepseek.com/responses",
    });
    expect(await outcome(timeout)).toEqual({
      failed: null,
      retried: "AGENT_MODEL_RESPONSE_TIMEOUT",
    });
    const serverError = new APICallError({
      isRetryable: true,
      message: "server",
      requestBodyValues: {},
      statusCode: 500,
      url: "https://api.deepseek.com/responses",
    });
    expect(await outcome(serverError)).toEqual({
      failed: null,
      retried: "AGENT_MODEL_PROVIDER_ERROR",
    });
    const unauthorized = new APICallError({
      isRetryable: false,
      message: "unauthorized",
      requestBodyValues: {},
      statusCode: 401,
      url: "https://api.deepseek.com/responses",
    });
    expect(await outcome(unauthorized)).toEqual({
      failed: "AGENT_MODEL_API_KEY_INVALID",
      retried: null,
    });
  });

  it("names a failure before the model call by its stage, and does not count it as paid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = new Error("connection terminated");
    const lease = dependencies({
      stillLeased: vi.fn(async () => {
        throw broken;
      }),
    });
    await runPersonCardBuild(build, lease);
    expect(lease.generate).not.toHaveBeenCalled();
    expect(lease.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "AGENT_PERSON_CARD_LEASE_FAILED", possiblyPaid: false }),
    );
    const retire = dependencies({
      loadSources: vi.fn(async () => ({
        episodes: [],
        readIds: [],
        records: [],
        sourcesAsOf: new Date(),
        subjectLabel: "Юра",
        totalRecords: 0,
      })),
      retire: vi.fn(async () => {
        throw broken;
      }),
    });
    await runPersonCardBuild(build, retire);
    expect(retire.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "AGENT_PERSON_CARD_RETIRE_FAILED",
        possiblyPaid: false,
      }),
    );
  });

  it("marks a build possibly paid from the model call on, unless the provider refused first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const status = (statusCode: number) =>
      new APICallError({
        isRetryable: true,
        message: "status",
        requestBodyValues: {},
        statusCode,
        url: "https://api.deepseek.com/responses",
      });
    const paid = async (error: unknown) => {
      const deps = dependencies({
        generate: vi.fn(async () => {
          throw error;
        }),
      });
      await runPersonCardBuild(build, deps);
      const [call] = [
        ...vi.mocked(deps.releaseForRetry).mock.calls,
        ...vi.mocked(deps.fail).mock.calls,
      ];
      return call?.[0].possiblyPaid;
    };
    expect(await paid(status(429))).toBe(false);
    expect(await paid(status(503))).toBe(false);
    expect(await paid(new AppError("AGENT_MODEL_BALANCE_EXHAUSTED", "402"))).toBe(false);
    for (const code of [
      "AGENT_MODEL_REQUEST_INVALID",
      "AGENT_MODEL_API_KEY_INVALID",
      "AGENT_MODEL_PARAMETERS_INVALID",
    ]) {
      expect(await paid(new AppError(code, "refused"))).toBe(false);
    }
    expect(await paid({ isRetryable: false, statusCode: 429, type: "error" })).toBe(false);
    expect(await paid(status(500))).toBe(true);
    expect(await paid(new TypeError("terminated"))).toBe(true);
    expect(
      await paid(new PersonCardAnswerInterrupted({ isRetryable: true, statusCode: 429 })),
    ).toBe(true);
    const notCard = dependencies({
      generate: vi.fn(async () => ({
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        text: "не могу",
      })),
    });
    await runPersonCardBuild(build, notCard);
    expect(notCard.fail).toHaveBeenCalledWith(expect.objectContaining({ possiblyPaid: true }));
  });

  it("does not pay for a model call once the lease is gone, and logs a lost lease as such", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gone = dependencies({ stillLeased: vi.fn(async () => false) });
    await runPersonCardBuild(build, gone);
    expect(gone.generate).not.toHaveBeenCalled();
    expect(gone.fail).not.toHaveBeenCalled();
    const taken = dependencies({
      generate: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      releaseForRetry: vi.fn(async () => "lost" as const),
    });
    await runPersonCardBuild(build, taken);
    expect(warn).toHaveBeenLastCalledWith(
      expect.stringContaining('"code":"AGENT_PERSON_CARD_LEASE_LOST"'),
    );
  });

  it("returns an unclear model outcome to the queue without publishing", async () => {
    const deps = dependencies({
      generate: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await runPersonCardBuild(build, deps);
    expect(deps.releaseForRetry).toHaveBeenCalledWith({
      buildId: "build-1",
      errorCode: "AGENT_PERSON_CARD_GENERATE_FAILED",
      leaseToken: "lease-1",
      possiblyPaid: true,
    });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("fails a build whose answer is not a card and retires a card with no records", async () => {
    const notCard = dependencies({
      generate: vi.fn(async () => ({
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        text: "не могу",
      })),
    });
    await runPersonCardBuild(build, notCard);
    expect(notCard.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "AGENT_PERSON_CARD_RESPONSE_INVALID", inputRecords: 1 }),
    );
    expect(notCard.releaseForRetry).not.toHaveBeenCalled();

    const empty = dependencies({
      loadSources: vi.fn(async () => ({
        episodes: [],
        readIds: [],
        records: [],
        sourcesAsOf: new Date(),
        subjectLabel: "Юра",
        totalRecords: 0,
      })),
    });
    await runPersonCardBuild(build, empty);
    expect(empty.generate).not.toHaveBeenCalled();
    // Nothing left to build from: the card goes, and that is not a failure to repeat daily.
    expect(empty.retire).toHaveBeenCalledWith({
      buildId: "build-1",
      key: build.key,
      leaseToken: "lease-1",
    });
    expect(empty.fail).not.toHaveBeenCalled();
  });

  it("records nothing after a lost lease and passes the switch to the cleanup", async () => {
    const lost = dependencies({
      publish: vi.fn(async () => {
        throw new AppError("AGENT_PERSON_CARD_LEASE_LOST", "lost");
      }),
    });
    await runPersonCardBuild(build, lost);
    expect(lost.fail).not.toHaveBeenCalled();
    expect(lost.releaseForRetry).not.toHaveBeenCalled();

    const off = dependencies({ cleanupEnabled: () => false });
    await runPersonCardBuild(build, off);
    // What the card counts as read comes from the sources, over the input cap included.
    expect(off.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupEnabled: false,
        leaseToken: "lease-1",
        readIds: [record.id],
      }),
    );
  });
});
