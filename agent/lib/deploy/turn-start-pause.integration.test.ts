/**
 * The deploy's pause of new turns, in PostgreSQL.
 *
 * Constructs covered:
 * - A pause holds until its own deadline: the controller sets it before waiting for running turns
 *   and clears it once the release stopped; one it left behind expires on its own.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { isTurnStartPaused } from "./turn-start-pause.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("turn start pause", () => {
  afterAll(async () => {
    await database().query("DELETE FROM deploy_turn_pause");
    await closeDatabase();
  });

  it("is on only until its deadline", async () => {
    await database().query("DELETE FROM deploy_turn_pause");
    await expect(isTurnStartPaused()).resolves.toBe(false);
    await database().query("INSERT INTO deploy_turn_pause (paused_until) VALUES (now() + interval '15 minutes')");
    await expect(isTurnStartPaused()).resolves.toBe(true);
    await database().query("UPDATE deploy_turn_pause SET paused_until = now() - interval '1 second'");
    await expect(isTurnStartPaused()).resolves.toBe(false);
  });
});
