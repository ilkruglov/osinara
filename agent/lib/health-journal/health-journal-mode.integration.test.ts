/**
 * Where the journal lives and what it knows about itself (11 November 2026).
 *
 * Constructs covered:
 * - `get` tells a journal never written to, one written to, and one erased, as facts: Mia once read
 *   an empty new journal as «everything was erased».
 * - In the `files` mode every journal tool refuses with `AGENT_HEALTH_FILE_JOURNAL` and points to the
 *   person's files; `get` and `set_journal_mode` still work, and the person can switch back.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { bodyProfileRepository } from "./body-profile-repository.js";
import { foodLogRepository } from "./food-log-repository.js";
import {
  createHealthFamily,
  failureOf,
  nextOperationKey,
  noWorkspace,
} from "./health-journal.integration-fixtures.js";
import { assertDatabaseJournal, journalState } from "./health-access.js";
import { buildHealthSummary } from "./health-summary.js";
import { sleepActivityRepository } from "./sleep-activity-repository.js";
import { workoutRepository } from "./workout-repository.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const key = nextOperationKey;
const WATER = {
  action: "add" as const,
  estimateSource: "label" as const,
  items: [
    {
      amount: 250,
      countsAsWater: true,
      name: "Вода",
      per100: { carbs: 0, fat: 0, fiber: 0, kcal: 0, protein: 0 },
      unit: "ml" as const,
    },
  ],
  date: "2026-11-01",
  time: "12:00",
  title: "Вода",
};

type Journal = {
  journal: {
    erases: number;
    firstWriteAt: string | null;
    lastErasedAt: string | null;
    mode: string;
  };
};

describeWithDatabase("health journal mode and facts", () => {
  afterAll(closeDatabase);

  it("tells a new, a written and an erased journal apart", async () => {
    const { owner } = await createHealthFamily();
    const fresh = (await bodyProfileRepository.execute(owner, { action: "get" }, key())) as Journal;
    expect(fresh.journal).toEqual({
      erases: 0,
      firstWriteAt: null,
      lastErasedAt: null,
      mode: "database",
    });
    await foodLogRepository.execute(owner, WATER, key());
    const written = (await bodyProfileRepository.execute(
      owner,
      { action: "get" },
      key(),
    )) as Journal;
    expect(written.journal.firstWriteAt).not.toBeNull();
    expect(written.journal.erases).toBe(0);
    await bodyProfileRepository.execute(owner, { action: "erase_all" }, key());
    const erased = (await bodyProfileRepository.execute(
      owner,
      { action: "get" },
      key(),
    )) as Journal;
    expect(erased.journal).toMatchObject({ erases: 1, firstWriteAt: null, mode: "database" });
    expect(erased.journal.lastErasedAt).not.toBeNull();
  });

  it("refuses every journal tool in the files mode and lets the person switch back", async () => {
    const { owner } = await createHealthFamily();
    expect(
      await bodyProfileRepository.execute(
        owner,
        { action: "set_journal_mode", journalMode: "files" },
        key(),
      ),
    ).toMatchObject({ journal: { mode: "files" } });
    const refusals = [
      () => foodLogRepository.execute(owner, WATER, key()),
      () => foodLogRepository.execute(owner, { action: "day" }, key()),
      () => workoutRepository.execute(owner, { action: "list" }, key()),
      () => sleepActivityRepository.execute(owner, { action: "list" }, key()),
      () =>
        sleepActivityRepository.importZepp(
          owner,
          { contentSha256: "sha", path: "p", since: null },
          { activity: [], sleep: [], weighIns: [] },
          key(),
        ),
      () =>
        bodyProfileRepository.execute(
          owner,
          { action: "log_measurement", source: "text", weightKg: 60 },
          key(),
        ),
      () => buildHealthSummary(owner, noWorkspace, { action: "day" }, key()),
    ];
    for (const refusal of refusals) {
      const failure = await failureOf(refusal());
      expect(failure.code).toBe("AGENT_HEALTH_FILE_JOURNAL");
      expect(failure.message).toContain("health/README.md");
    }
    expect(await bodyProfileRepository.execute(owner, { action: "get" }, key())).toMatchObject({
      journal: { mode: "files" },
    });
    await bodyProfileRepository.execute(
      owner,
      { action: "set_journal_mode", journalMode: "database" },
      key(),
    );
    expect(await foodLogRepository.execute(owner, WATER, key())).toMatchObject({ replayed: false });
  });

  it("never tells the model how to switch the mode", async () => {
    const { owner } = await createHealthFamily();
    await bodyProfileRepository.execute(
      owner,
      { action: "set_journal_mode", journalMode: "files" },
      key(),
    );
    const failure = await failureOf(foodLogRepository.execute(owner, WATER, key()));
    expect(failure.code).toBe("AGENT_HEALTH_FILE_JOURNAL");
    expect(failure.message).not.toContain("set_journal_mode");
  });

  it("refuses a write that waited for the switch, and replays a write made before it", async () => {
    const { owner } = await createHealthFamily();
    const before = key();
    await foodLogRepository.execute(owner, WATER, before);
    // Hold the person's lock, queue the switch, then a write behind it.
    const holder = await database().connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${owner.userId}:health`,
    ]);
    const waiting = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await database().query<{ waiting: number }>(
          "SELECT count(*)::integer AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        if (result.rows[0]!.waiting >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("nobody waited for the lock");
    };
    const switching = bodyProfileRepository.execute(
      owner,
      { action: "set_journal_mode", journalMode: "files" },
      key(),
    );
    await waiting(1);
    const write = failureOf(foodLogRepository.execute(owner, WATER, key()));
    await waiting(2);
    await holder.query("COMMIT");
    holder.release();
    await switching;
    expect((await write).code).toBe("AGENT_HEALTH_FILE_JOURNAL");
    // The write committed before the switch replays as it was.
    expect(await foodLogRepository.execute(owner, WATER, before)).toMatchObject({ replayed: true });
  });

  it("lets an import made before the switch replay past the early check", async () => {
    const { owner } = await createHealthFamily();
    const imported = key();
    const archive = { contentSha256: "sha", path: "p", since: null };
    await sleepActivityRepository.importZepp(
      owner,
      archive,
      { activity: [], sleep: [], weighIns: [] },
      imported,
    );
    await bodyProfileRepository.execute(
      owner,
      { action: "set_journal_mode", journalMode: "files" },
      key(),
    );
    // The tool checks the mode before reading the archive; a replay of a committed import passes.
    await expect(assertDatabaseJournal(owner, imported)).resolves.toBeUndefined();
    expect((await failureOf(assertDatabaseJournal(owner, key()))).code).toBe(
      "AGENT_HEALTH_FILE_JOURNAL",
    );
  });

  it("erases the database copies in the files mode and keeps the mode", async () => {
    const { owner } = await createHealthFamily();
    await foodLogRepository.execute(owner, WATER, key());
    await bodyProfileRepository.execute(
      owner,
      { action: "set_journal_mode", journalMode: "files" },
      key(),
    );
    expect(
      await bodyProfileRepository.execute(owner, { action: "erase_all" }, key()),
    ).toMatchObject({
      erased: { health_food_entries: 1 },
    });
    expect(await bodyProfileRepository.execute(owner, { action: "get" }, key())).toMatchObject({
      journal: { erases: 1, mode: "files" },
    });
    expect(await journalState(database(), owner.userId!)).toEqual({ erases: 1, mode: "files" });
  });

  it("shows only the journal's facts in the files mode", async () => {
    const { owner } = await createHealthFamily();
    await bodyProfileRepository.execute(
      owner,
      { action: "log_measurement", source: "text", weightKg: 63.7 },
      key(),
    );
    await bodyProfileRepository.execute(
      owner,
      { action: "set_journal_mode", journalMode: "files" },
      key(),
    );
    const read = (await bodyProfileRepository.execute(owner, { action: "get" }, key())) as Record<
      string,
      unknown
    >;
    expect(read).toHaveProperty("journal");
    expect(read).not.toHaveProperty("latestWeight");
    expect(read).not.toHaveProperty("targets");
  });

  it("remembers a write after its record is removed", async () => {
    const { owner } = await createHealthFamily();
    await sleepActivityRepository.execute(
      owner,
      { action: "log_sleep", source: "text", totalMin: 400, wakeDate: "2026-11-01" },
      key(),
    );
    await sleepActivityRepository.execute(
      owner,
      { action: "remove", date: "2026-11-01", kind: "sleep" },
      key(),
    );
    const read = (await bodyProfileRepository.execute(owner, { action: "get" }, key())) as Journal;
    expect(read.journal.firstWriteAt).not.toBeNull();
    expect(read.journal.erases).toBe(0);
  });
});
