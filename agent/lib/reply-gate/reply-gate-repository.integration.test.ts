/**
 * Reply gate repository tests (PostgreSQL).
 *
 * Constructs covered:
 * - The verdict and the response kind land in the same evaluation row as the outcome, whichever
 *   writer comes first, and each writer keeps the others' columns.
 * - A scored verdict stores the metrics, the scores and the model; an unavailable one stores the
 *   error code and the metrics without scores; a skipped one only the status and code.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { turnEvaluationRepository } from "../turn-quality/turn-evaluation-repository.js";
import { replyGateRepository } from "./reply-gate-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const versions = { modelConfigHash: "a".repeat(32), promptHash: "b".repeat(32), softwareVersion: "1.8.36" };
const metrics = { replyChainDepth: 2, sameAuthorRun: 3, triggerKind: "reply_to_mia" as const };
const scores = { asked: 0.2, escalates: 0.9, register: "retort", registerConfidence: 0.7, repeatsSelf: 0.4, thirdParty: 0.1, worth: 0.8 };

describeWithDatabase("replyGateRepository", () => {
  let familyId: string;

  beforeEach(async () => {
    await database().query("TRUNCATE turn_evaluations, users, families CASCADE");
    familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Ворота') RETURNING id")).rows[0]!.id;
  });
  afterAll(closeDatabase);

  const identity = (turn: string) => ({ chatKind: "external" as const, eveSessionId: "eve-g", eveTurnId: turn, familyId, telegramChatId: "-100555", triggeringEntryId: null });

  async function row(turn: string) {
    return (await database().query(
      `SELECT outcome, response_kind, trigger_kind, reply_chain_depth, same_author_run, gate_status, gate_error_code, gate_model,
              gate_latency_ms, gate_register, gate_register_confidence, gate_worth, gate_escalates, gate_third_party, gate_repeats_self, gate_asked
         FROM turn_evaluations WHERE eve_session_id = 'eve-g' AND eve_turn_id = $1`,
      [turn],
    )).rows[0];
  }

  it("keeps the verdict, the response kind and the outcome of a turn in one row", async () => {
    await replyGateRepository.recordVerdict(identity("t1"), {
      errorCode: null, latencyMs: 210, metrics, model: "jev-1.13.0", scores, status: "scored", versions,
    });
    await replyGateRepository.recordResponseKind(identity("t1"), "text", versions);
    await turnEvaluationRepository.recordOutcome(identity("t1"), {
      failedToolCount: 0, failureCode: null, finishedAt: new Date(), loadedSkills: [],
      metrics: { forbiddenTool: false, repeatAfterError: false, repeatedCallRun: 1 }, outcome: "completed", stepCount: 1, toolCalls: [], versions,
    });

    expect(await row("t1")).toMatchObject({
      gate_asked: 0.2, gate_escalates: 0.9, gate_latency_ms: 210, gate_model: "jev-1.13.0", gate_register: "retort",
      gate_register_confidence: 0.7, gate_repeats_self: 0.4, gate_status: "scored", gate_third_party: 0.1, gate_worth: 0.8,
      outcome: "completed", reply_chain_depth: 2, response_kind: "text", same_author_run: 3, trigger_kind: "reply_to_mia",
    });
  });

  it("records an unavailable vendor with the metrics and a skipped gate with only its code", async () => {
    await replyGateRepository.recordVerdict(identity("t2"), {
      errorCode: "AGENT_JEV_UNAVAILABLE", latencyMs: null, metrics, model: null, scores: null, status: "unavailable", versions,
    });
    expect(await row("t2")).toMatchObject({ gate_error_code: "AGENT_JEV_UNAVAILABLE", gate_register: null, gate_status: "unavailable", gate_worth: null, same_author_run: 3 });
    await replyGateRepository.recordVerdict(identity("t3"), {
      errorCode: "AGENT_REPLY_GATE_NOT_CONFIGURED", latencyMs: null, metrics: null, model: null, scores: null, status: "skipped", versions,
    });
    await replyGateRepository.recordResponseKind(identity("t3"), "silent", versions);
    expect(await row("t3")).toMatchObject({ gate_error_code: "AGENT_REPLY_GATE_NOT_CONFIGURED", gate_status: "skipped", response_kind: "silent", trigger_kind: null });
  });
});
