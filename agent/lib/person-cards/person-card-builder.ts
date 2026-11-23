/**
 * One person card build: records → model → checked card → publish.
 *
 * Exports:
 * - `PersonCardBuildDependencies`: the seams tests replace.
 * - `runPersonCardBuild`: runs a claimed build to its outcome; never throws.
 *
 * Key constructs:
 * - Outcomes: published (`AGENT_PERSON_CARD_BUILT`); a model call with an unclear outcome
 *   (timeout, network, provider-side error, `person-card-generation.ts`) goes back to the queue
 *   (`AGENT_PERSON_CARD_RETRY`) and publishes nothing, on the third attempt (an expired lease
 *   counts too) it fails the build; no records left retires the card (`AGENT_PERSON_CARD_RETIRED`);
 *   anything definite fails the build (`AGENT_PERSON_CARD_FAILED`); a lost lease does nothing
 *   (`AGENT_PERSON_CARD_LEASE_LOST`), its replacement owns the build, and a build that lost it
 *   before the model call does not pay. A failed build counts toward the card's one build a day
 *   like a published one.
 * - Logs carry ids, counts and codes only, never record or card text.
 */
import { sqlState } from "../transaction-conflict-retry.js";
import {
  personCardDispatchRepository,
  type ClaimedPersonCardBuild,
} from "./person-card-dispatch-repository.js";
import { parsePersonCardResponse } from "./person-card-parse.js";
import { buildPersonCardPrompt, numberPersonCardRecords } from "./person-card-prompt.js";
import {
  failPersonCardBuild,
  publishPersonCard,
  retirePersonCard,
  type PublishPersonCardInput,
  type PublishPersonCardResult,
} from "./person-card-publish-repository.js";
import { loadPersonCardSources, type PersonCardSources } from "./person-card-sources-repository.js";
import type { PersonCardKey } from "./person-card-links.js";
import {
  describeModelFailure,
  generatePersonCard,
  type PersonCardGeneration,
} from "./person-card-generation.js";

export interface PersonCardBuildDependencies {
  /** False when the build no longer held its lease. */
  fail(input: Parameters<typeof failPersonCardBuild>[0]): Promise<boolean>;
  generate(input: { prompt: string; system: string }): Promise<PersonCardGeneration>;
  loadSources(key: PersonCardKey): Promise<PersonCardSources>;
  publish(input: PublishPersonCardInput): Promise<PublishPersonCardResult>;
  retire(input: Parameters<typeof retirePersonCard>[0]): Promise<void>;
  releaseForRetry(
    input: Parameters<typeof personCardDispatchRepository.releaseForRetry>[0],
  ): Promise<"failed" | "lost" | "retry">;
  /** The build still holds its lease: checked before paying for the model call. */
  stillLeased(build: ClaimedPersonCardBuild): Promise<boolean>;
}

class StageError extends Error {
  constructor(
    readonly code: string,
    readonly stage: "generate" | "lease" | "load" | "parse" | "publish" | "retire",
    readonly cause: unknown,
    /** Only a model call can end unclearly: the same request may still succeed. */
    readonly unclear = false,
  ) {
    super(code);
  }
}

export const personCardBuildDependencies: PersonCardBuildDependencies = {
  fail: failPersonCardBuild,
  generate: generatePersonCard,
  loadSources: loadPersonCardSources,
  publish: publishPersonCard,
  retire: retirePersonCard,
  releaseForRetry: (input) => personCardDispatchRepository.releaseForRetry(input),
  stillLeased: (build) => personCardDispatchRepository.stillLeased(build.id, build.leaseToken),
};

async function stage<T>(name: StageError["stage"], run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const failure = describeModelFailure(error, `AGENT_PERSON_CARD_${name.toUpperCase()}_FAILED`);
    const generate = name === "generate";
    throw new StageError(failure.code, name, error, generate && failure.unclear);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export async function runPersonCardBuild(
  build: ClaimedPersonCardBuild,
  dependencies: PersonCardBuildDependencies = personCardBuildDependencies,
): Promise<void> {
  const startedAt = performance.now();
  const base = {
    area: build.key.area,
    attempt: build.attempts,
    buildId: build.id,
    reason: build.reason,
  };
  let inputRecords: number | null = null;
  try {
    const sources = await stage("load", () => dependencies.loadSources(build.key));
    if (sources.records.length === 0) {
      await stage("retire", () =>
        dependencies.retire({ buildId: build.id, key: build.key, leaseToken: build.leaseToken }),
      );
      console.info(JSON.stringify({ ...base, code: "AGENT_PERSON_CARD_RETIRED" }));
      return;
    }
    const records = numberPersonCardRecords(sources.records, sources.episodes);
    inputRecords = records.length;
    const { prompt, system } = buildPersonCardPrompt({
      area: build.key.area,
      records,
      subjectLabel: sources.subjectLabel,
    });
    if (!(await stage("lease", () => dependencies.stillLeased(build)))) {
      throw new StageError("AGENT_PERSON_CARD_LEASE_LOST", "lease", null);
    }
    const generation = await stage("generate", () => dependencies.generate({ prompt, system }));
    const parsed = await stage("parse", () => parsePersonCardResponse(generation.text, records));
    const published = await stage("publish", () =>
      dependencies.publish({
        buildId: build.id,
        characters: parsed.characters,
        cited: parsed.cited,
        inputRecords: records.length,
        key: build.key,
        leaseToken: build.leaseToken,
        readIds: sources.readIds,
        sections: parsed.sections,
        sourcesAsOf: sources.sourcesAsOf,
        subjectLabel: sources.subjectLabel,
      }),
    );
    console.info(
      JSON.stringify({
        ...base,
        characters: parsed.characters,
        cited: parsed.cited.length,
        code: "AGENT_PERSON_CARD_BUILT",
        episodes: sources.episodes.length,
        inputTokens: generation.inputTokens,
        itemsDropped: parsed.droppedItems,
        ms: Math.round(performance.now() - startedAt),
        outputTokens: generation.outputTokens,
        reasoningTokens: generation.reasoningTokens,
        records: sources.records.length,
        recordsOverCap: sources.totalRecords - sources.records.length,
        version: published.cardVersion,
      }),
    );
  } catch (error) {
    const failure =
      error instanceof StageError
        ? error
        : new StageError("AGENT_PERSON_CARD_BUILD_FAILED", "publish", error);
    const details = {
      ...base,
      errorName: errorName(failure.cause),
      ms: Math.round(performance.now() - startedAt),
      sqlState: sqlState(failure.cause),
      stage: failure.stage,
    };
    try {
      if (failure.code === "AGENT_PERSON_CARD_LEASE_LOST") {
        console.warn(JSON.stringify({ ...details, code: failure.code }));
        return;
      }
      // Only a model call with an unclear outcome is worth another attempt on the same request.
      // A database error fails the build; the next due check queues the person again.
      if (failure.unclear) {
        const outcome = await dependencies.releaseForRetry({
          buildId: build.id,
          errorCode: failure.code,
          leaseToken: build.leaseToken,
        });
        const code = {
          failed: "AGENT_PERSON_CARD_FAILED",
          lost: "AGENT_PERSON_CARD_LEASE_LOST",
          retry: "AGENT_PERSON_CARD_RETRY",
        }[outcome];
        console.warn(JSON.stringify({ ...details, code, errorCode: failure.code }));
        return;
      }
      const recorded = await dependencies.fail({
        buildId: build.id,
        errorCode: failure.code,
        inputRecords,
        leaseToken: build.leaseToken,
      });
      console.warn(
        JSON.stringify({
          ...details,
          code: recorded ? "AGENT_PERSON_CARD_FAILED" : "AGENT_PERSON_CARD_LEASE_LOST",
          errorCode: failure.code,
        }),
      );
    } catch (recordError) {
      // The lease runs out and the build is reclaimed: nothing is lost.
      console.error(
        JSON.stringify({
          ...details,
          code: "AGENT_PERSON_CARD_OUTCOME_UNRECORDED",
          errorCode: failure.code,
          recordErrorName: errorName(recordError),
        }),
      );
    }
  }
}
