/**
 * Turn exchange repository tests (PostgreSQL).
 *
 * Constructs covered:
 * - The exchange metrics and the response kind land in the same evaluation row as the outcome,
 *   whichever writer comes first, and each writer keeps the others' columns.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { turnEvaluationRepository } from "./turn-evaluation-repository.js";
import { turnExchangeRepository } from "./turn-exchange-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const versions = { modelConfigHash: "a".repeat(32), promptHash: "b".repeat(32), softwareVersion: "1.8.55" };

describeWithDatabase("turnExchangeRepository", () => {
  let familyId: string;

  beforeEach(async () => {
    await database().query("TRUNCATE turn_evaluations, users, families CASCADE");
    familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Обмен') RETURNING id")).rows[0]!.id;
  });
  afterAll(closeDatabase);

  const identity = (turn: string) => ({ chatKind: "external" as const, eveSessionId: "eve-g", eveTurnId: turn, familyId, telegramChatId: "-100555", triggeringEntryId: null });

  async function row(turn: string) {
    return (await database().query(
      `SELECT outcome, response_kind, trigger_kind, reply_chain_depth, same_author_run, gate_status
         FROM turn_evaluations WHERE eve_session_id = 'eve-g' AND eve_turn_id = $1`,
      [turn],
    )).rows[0];
  }

  it("keeps the exchange metrics, the response kind and the outcome of a turn in one row", async () => {
    await turnExchangeRepository.recordMetrics(identity("t1"), { replyChainDepth: 2, sameAuthorRun: 3, triggerKind: "reply_to_mia" }, versions);
    await turnExchangeRepository.recordResponseKind(identity("t1"), "text", versions);
    await turnEvaluationRepository.recordOutcome(identity("t1"), {
      failedToolCount: 0, failureCode: null, finishedAt: new Date(), loadedSkills: [],
      metrics: { forbiddenTool: false, repeatAfterError: false, repeatedCallRun: 1 }, outcome: "completed", stepCount: 1, toolCalls: [], versions,
    });

    expect(await row("t1")).toMatchObject({
      gate_status: null, outcome: "completed", reply_chain_depth: 2, response_kind: "text", same_author_run: 3, trigger_kind: "reply_to_mia",
    });
  });

  it("records the response kind of a turn that has no metrics", async () => {
    await turnExchangeRepository.recordResponseKind(identity("t2"), "silent", versions);
    expect(await row("t2")).toMatchObject({ response_kind: "silent", trigger_kind: null });
  });
});
