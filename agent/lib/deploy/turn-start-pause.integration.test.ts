/**
 * The deploy's pause of new turns, in PostgreSQL.
 *
 * Constructs covered:
 * - A pause holds until its own deadline: the controller sets it before waiting for running turns
 *   and clears it once the release stopped; one it left behind expires on its own.
 * - The controller's pause commits only after the claims holding the shared lock have committed,
 *   so its wait sees every claim that read no pause.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { stillPendingAfter } from "./claimed-turn-work.test-support.js";
import { TURN_START_LOCK_SQL, TURN_START_PAUSED_SQL } from "./turn-start-pause.js";

async function isTurnStartPaused(): Promise<boolean> {
  const result = await database().query<{ paused: boolean }>(
    `SELECT ${TURN_START_PAUSED_SQL} AS paused`,
  );
  return result.rows[0]?.paused === true;
}

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/** The SQL `pause_new_turns` sends, read from the controller's script with its psql call stubbed. */
function controllerPauseSql(): string {
  const scripts = fileURLToPath(new URL("../../../scripts/production-deploy/", import.meta.url));
  return execFileSync(
    "bash",
    [
      "-c",
      `source "${scripts}common.sh"; source "${scripts}database.sh"
       compose_current_within() { cat; }
       pause_new_turns`,
    ],
    { encoding: "utf8" },
  );
}

describeWithDatabase("turn start pause", () => {
  afterAll(async () => {
    await database().query("DELETE FROM deploy_turn_pause");
    await closeDatabase();
  });

  // /code-review of the drain fix, 9 November 2026: a claim still in its transaction when the pause
  // committed was invisible to the deploy's wait; the controller now waits for such claims.
  it("is set by the controller only once the claims under way have committed", async () => {
    await database().query("DELETE FROM deploy_turn_pause");
    const claim = await database().connect();
    const controller = await database().connect();
    try {
      await claim.query("BEGIN");
      await claim.query(TURN_START_LOCK_SQL);

      const pausing = controller.query(controllerPauseSql());
      const waited = await stillPendingAfter(pausing, 300);
      await expect(isTurnStartPaused()).resolves.toBe(false);
      await claim.query("COMMIT");
      await pausing;

      expect(waited).toBe(true);
      await expect(isTurnStartPaused()).resolves.toBe(true);
    } finally {
      claim.release();
      controller.release();
      await database().query("DELETE FROM deploy_turn_pause");
    }
  });

  it("is on only until its deadline", async () => {
    await database().query("DELETE FROM deploy_turn_pause");
    await expect(isTurnStartPaused()).resolves.toBe(false);
    await database().query(
      "INSERT INTO deploy_turn_pause (paused_until) VALUES (now() + interval '15 minutes')",
    );
    await expect(isTurnStartPaused()).resolves.toBe(true);
    await database().query(
      "UPDATE deploy_turn_pause SET paused_until = now() - interval '1 second'",
    );
    await expect(isTurnStartPaused()).resolves.toBe(false);
  });
});
