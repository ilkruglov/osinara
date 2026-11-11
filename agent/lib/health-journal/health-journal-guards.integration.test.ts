/**
 * Health journal guards against PostgreSQL: the review findings of 11 November 2026 and the plan's
 * acceptance criteria the first tests left open.
 *
 * Constructs covered:
 * - Another member reads and changes nothing of a person's journal in any table.
 * - Every write replays by its call id; erasing replays as one erase, and an earlier write replayed
 *   after it does not bring the data back.
 * - A pulse typed in the chat does not keep a later import's steps out; weigh-in keys are the
 *   export's own text.
 * - Sleep: zero phases fall back to the window, a clock change counts, an impossible night is a
 *   named input error.
 * - Food: an edit without date or time keeps the moment after a timezone change; day totals cover
 *   more entries than the list shows, and the list stays bounded.
 * - Safety: a person's own target is refused while a deficit is blocked and maintenance unknown.
 * - The day card is drawn from the database's numbers.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { bodyProfileRepository, ERASED_TABLES } from "./body-profile-repository.js";
import { foodLogRepository } from "./food-log-repository.js";
import { eraseCount } from "./health-card-files.js";
import { renderDayCard } from "./health-cards.js";
import {
  createHealthFamily,
  failureOf,
  nextOperationKey,
  noWorkspace,
} from "./health-journal.integration-fixtures.js";
import { buildHealthSummary } from "./health-summary.js";
import type { DaySummary } from "./health-summary-data.js";
import { sleepActivityRepository } from "./sleep-activity-repository.js";
import { workoutRepository } from "./workout-repository.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const key = nextOperationKey;
const family = createHealthFamily;
const failure = failureOf;
const KEFIR = { carbs: 4, fat: 1, fiber: 0, kcal: 40, protein: 3 };

const kefir = (title = "Кефир") => ({
  action: "add" as const,
  date: "2026-11-09",
  estimateSource: "label" as const,
  items: [{ amount: 250, name: "Кефир", per100: KEFIR, unit: "ml" as const }],
  time: "08:00",
  title,
});

describeWithDatabase("health journal guards", () => {
  afterAll(closeDatabase);

  it("lets another member read and change nothing in any table", async () => {
    const { member, owner } = await family();
    const food = (await foodLogRepository.execute(owner, kefir(), key())) as {
      entry: { id: string };
    };
    const measured = (await bodyProfileRepository.execute(
      owner,
      { action: "log_measurement", date: "2026-11-09", source: "text", weightKg: 70 },
      key(),
    )) as { measurement: { id: string } };
    const workout = (await workoutRepository.execute(
      owner,
      {
        action: "add",
        date: "2026-11-09",
        durationMin: 30,
        intensity: "light",
        kind: "mobility",
        title: "Йога",
      },
      key(),
    )) as { workout: { id: string } };
    await sleepActivityRepository.execute(
      owner,
      { action: "log_sleep", source: "text", totalMin: 420, wakeDate: "2026-11-09" },
      key(),
    );
    await sleepActivityRepository.execute(
      owner,
      { action: "log_activity", date: "2026-11-09", source: "text", steps: 9000 },
      key(),
    );
    await bodyProfileRepository.execute(
      owner,
      { action: "set_profile", heightCm: 180, sex: "male" },
      key(),
    );

    const notFound = "AGENT_HEALTH_RECORD_NOT_FOUND";
    // Thunks run one by one: a promise created early would reject before anything awaits it.
    const tries: Array<() => Promise<unknown>> = [
      () => foodLogRepository.execute(member, { action: "get", id: food.entry.id }, key()),
      () =>
        foodLogRepository.execute(
          member,
          { action: "remove", id: food.entry.id, version: 1 },
          key(),
        ),
      () =>
        foodLogRepository.execute(
          member,
          { action: "update", id: food.entry.id, title: "чужое", version: 1 },
          key(),
        ),
      () =>
        bodyProfileRepository.execute(
          member,
          { action: "remove_measurement", id: measured.measurement.id },
          key(),
        ),
      () => workoutRepository.execute(member, { action: "get", id: workout.workout.id }, key()),
      () =>
        workoutRepository.execute(
          member,
          { action: "remove", id: workout.workout.id, version: 1 },
          key(),
        ),
      () =>
        sleepActivityRepository.execute(
          member,
          { action: "remove", date: "2026-11-09", kind: "sleep" },
          key(),
        ),
      () =>
        sleepActivityRepository.execute(
          member,
          { action: "remove", date: "2026-11-09", kind: "activity" },
          key(),
        ),
    ];
    for (const attempt of tries) expect((await failure(attempt())).code).toBe(notFound);
    expect(
      await sleepActivityRepository.execute(
        member,
        { action: "list", from: "2026-11-09", to: "2026-11-09" },
        key(),
      ),
    ).toMatchObject({ activity: [], sleep: [] });
    expect(await bodyProfileRepository.execute(member, { action: "get" }, key())).toMatchObject({
      latestWeight: null,
      profile: { heightCm: null, version: null },
    });
    expect(
      await workoutRepository.execute(
        member,
        { action: "list", from: "2026-11-09", to: "2026-11-09" },
        key(),
      ),
    ).toMatchObject({ workouts: [] });
    const memberDay = (await buildHealthSummary(
      member,
      noWorkspace,
      { action: "day", date: "2026-11-09" },
      key(),
    )) as { day: DaySummary };
    expect(memberDay.day).toMatchObject({ activity: null, eaten: { kcal: 0 }, sleep: null });
    // The owner's journal is intact after every attempt.
    expect(
      await foodLogRepository.execute(owner, { action: "day", date: "2026-11-09" }, key()),
    ).toMatchObject({ totals: { entries: 1 } });
  });

  it("erases every table that holds a person's journal", async () => {
    const tables = await database().query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'owner_user_id'
          AND table_name LIKE 'health\\_%' ORDER BY table_name`,
    );
    // The operations journal is kept with its results marked erased (see eraseAll).
    expect(
      tables.rows.map((row) => row.name).filter((name) => name !== "health_operations"),
    ).toEqual([...ERASED_TABLES].sort());
  });

  it("counts every erase, the second one too", async () => {
    const { owner } = await family();
    await bodyProfileRepository.execute(owner, { action: "erase_all" }, key());
    await bodyProfileRepository.execute(owner, { action: "erase_all" }, key());
    expect(await eraseCount(database(), owner.userId!)).toBe(2);
  });

  it("replays every write by its call id, and erasing as one erase", async () => {
    const { owner } = await family();
    const writes: Array<[string, () => Promise<unknown>]> = [];
    const once = (name: string, run: (operationKey: string) => Promise<unknown>) => {
      const operationKey = key();
      writes.push([name, () => run(operationKey)]);
    };
    once("profile", (k) =>
      bodyProfileRepository.execute(owner, { action: "set_profile", heightCm: 170 }, k),
    );
    once("weight", (k) =>
      bodyProfileRepository.execute(
        owner,
        { action: "log_measurement", source: "text", weightKg: 64 },
        k,
      ),
    );
    once("sleep", (k) =>
      sleepActivityRepository.execute(
        owner,
        { action: "log_sleep", source: "text", totalMin: 400, wakeDate: "2026-11-08" },
        k,
      ),
    );
    once("activity", (k) =>
      sleepActivityRepository.execute(
        owner,
        { action: "log_activity", date: "2026-11-08", source: "text", steps: 5000 },
        k,
      ),
    );
    once("workout", (k) =>
      workoutRepository.execute(
        owner,
        { action: "add", durationMin: 20, intensity: "light", kind: "cardio", title: "Вело" },
        k,
      ),
    );
    once("import", (k) =>
      sleepActivityRepository.importZepp(
        owner,
        { contentSha256: "sha", path: "inbox/1/a.zip", since: null },
        { activity: [{ date: "2026-11-01", distanceM: 100, steps: 150 }], sleep: [], weighIns: [] },
        k,
      ),
    );
    const foodKey = key();
    writes.push(["food", () => foodLogRepository.execute(owner, kefir(), foodKey)]);
    for (const [name, write] of writes) {
      const first = (await write()) as { replayed: boolean };
      const second = (await write()) as { replayed: boolean };
      expect([name, first.replayed, second.replayed]).toEqual([name, false, true]);
    }
    const counts = async () =>
      (
        await database().query<{ rows: number }>(
          `SELECT (SELECT count(*) FROM health_food_entries WHERE owner_user_id = $1)
                + (SELECT count(*) FROM health_workouts WHERE owner_user_id = $1)
                + (SELECT count(*) FROM health_sleep WHERE owner_user_id = $1)::integer AS rows`,
          [owner.userId],
        )
      ).rows[0]!.rows;
    expect(Number(await counts())).toBe(3);

    const eraseKey = key();
    const erased = (await bodyProfileRepository.execute(
      owner,
      { action: "erase_all" },
      eraseKey,
    )) as {
      erased: Record<string, number>;
      replayed: boolean;
    };
    expect(erased).toMatchObject({ erased: { health_food_entries: 1 }, replayed: false });
    // A new entry after the erase survives a replay of the erase; the old food call does not
    // write its meal again.
    await foodLogRepository.execute(owner, kefir("После стирания"), key());
    expect(
      await bodyProfileRepository.execute(owner, { action: "erase_all" }, eraseKey),
    ).toMatchObject({ replayed: true });
    expect(await foodLogRepository.execute(owner, kefir(), foodKey)).toMatchObject({
      erased: true,
      replayed: true,
    });
    const day = (await foodLogRepository.execute(
      owner,
      { action: "day", date: "2026-11-09" },
      key(),
    )) as { entries: Array<{ title: string }> };
    expect(day.entries.map((entry) => entry.title)).toEqual(["После стирания"]);
  });

  it("lets an import fill the steps of a day the chat gave only a pulse for", async () => {
    const { owner } = await family();
    await sleepActivityRepository.execute(
      owner,
      { action: "log_activity", date: "2026-10-01", restingHr: 58, source: "text" },
      key(),
    );
    await sleepActivityRepository.execute(
      owner,
      { action: "log_activity", date: "2026-10-02", source: "text", steps: 7000 },
      key(),
    );
    const imported = await sleepActivityRepository.importZepp(
      owner,
      { contentSha256: "sha", path: "p", since: null },
      {
        activity: [
          { date: "2026-10-01", distanceM: 9000, steps: 12000 },
          { date: "2026-10-02", distanceM: 9000, steps: 12000 },
        ],
        sleep: [],
        weighIns: [{ bodyFatPct: null, measuredAt: "2026-10-01T05:10:00Z", weightKg: 64.9 }],
      },
      key(),
    );
    expect(imported).toMatchObject({ activity: { added: 0, kept: 1, refreshed: 1 } });
    const rows = await database().query<{ date: string; resting_hr: number; steps: number }>(
      `SELECT local_date::text AS date, steps, resting_hr FROM health_activity_days
        WHERE owner_user_id = $1 ORDER BY local_date`,
      [owner.userId],
    );
    expect(rows.rows).toEqual([
      { date: "2026-10-01", resting_hr: 58, steps: 12000 },
      { date: "2026-10-02", resting_hr: null, steps: 7000 },
    ]);
    const weighIn = await database().query<{ external_key: string }>(
      "SELECT external_key FROM health_body_measurements WHERE owner_user_id = $1",
      [owner.userId],
    );
    expect(weighIn.rows).toEqual([{ external_key: "2026-10-01T05:10:00Z" }]);
  });

  it("measures a night by the clock change and names an impossible one", async () => {
    const { owner } = await family("Europe/Berlin");
    // 25 October 2026 the clocks in Berlin go back: 00:00 to 08:00 is nine hours.
    expect(
      await sleepActivityRepository.execute(
        owner,
        {
          action: "log_sleep",
          bedtime: "00:00",
          deepMin: 0,
          source: "screenshot",
          wakeDate: "2026-10-25",
          wakeTime: "08:00",
        },
        key(),
      ),
    ).toMatchObject({ sleep: { totalMin: 540 } });
    const tooLong = await failure(
      sleepActivityRepository.execute(
        owner,
        {
          action: "log_sleep",
          deepMin: 600,
          lightMin: 600,
          remMin: 600,
          source: "text",
          wakeDate: "2026-10-26",
        },
        key(),
      ),
    );
    expect(tooLong.code).toBe("AGENT_HEALTH_INPUT_INVALID");
    expect(tooLong.message).toContain("Сон должен длиться от минуты до суток");
  });

  it("keeps a meal's moment through a note edit after a timezone change", async () => {
    const { owner } = await family("Europe/Moscow");
    const added = (await foodLogRepository.execute(
      owner,
      { ...kefir(), date: "2026-11-09", time: "23:30" },
      key(),
    )) as { entry: { id: string } };
    const before = await database().query<{ at: string; day: string }>(
      "SELECT eaten_at::text AS at, local_date::text AS day FROM health_food_entries WHERE id = $1",
      [added.entry.id],
    );
    await database().query(
      "UPDATE user_notification_settings SET timezone = 'Asia/Vladivostok' WHERE user_id = $1",
      [owner.userId],
    );
    await foodLogRepository.execute(
      owner,
      { action: "update", id: added.entry.id, note: "без сахара", version: 1 },
      key(),
    );
    const after = await database().query<{ at: string; day: string }>(
      "SELECT eaten_at::text AS at, local_date::text AS day FROM health_food_entries WHERE id = $1",
      [added.entry.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("totals every entry of a long day while listing a bounded page", async () => {
    const { familyId, owner } = await family();
    await database().query(
      `INSERT INTO health_food_entries (family_id, owner_user_id, eaten_at, local_date, title,
         estimate_source, items, kcal, protein_g, fat_g, carbs_g, fiber_g)
       SELECT $1, $2, timestamptz '2026-11-08 09:00+03' + n * interval '1 minute', date '2026-11-08',
              'Перекус ' || n, 'label',
              '[{"amount":10,"name":"Сухарик","per100":{"carbs":10,"fat":0,"fiber":0,"kcal":100,"protein":10},"unit":"g"}]',
              10, 1, 0, 1, 0
         FROM generate_series(1, 61) AS n`,
      [familyId, owner.userId],
    );
    const added = (await foodLogRepository.execute(
      owner,
      { ...kefir(), date: "2026-11-08", time: "22:00" },
      key(),
    )) as { dayTotals: { entries: number; kcal: number } };
    expect(added.dayTotals).toMatchObject({ entries: 62, kcal: 710 });
    const day = await foodLogRepository.execute(
      owner,
      { action: "day", date: "2026-11-08" },
      key(),
    );
    expect(day).toMatchObject({ hasMore: true, totals: { entries: 62, kcal: 710 } });
    expect((day as { entries: unknown[] }).entries).toHaveLength(60);
    expect(JSON.stringify(day).length).toBeLessThan(20_000);
  });

  it("refuses an own target while a deficit is blocked and maintenance is unknown", async () => {
    const { owner } = await family();
    const refused = await failure(
      bodyProfileRepository.execute(
        owner,
        { action: "set_profile", deficitBlock: "pregnancy", kcalTarget: 1300, sex: "female" },
        key(),
      ),
    );
    expect(refused.code).toBe("AGENT_HEALTH_PROFILE_INCOMPLETE");
    expect(refused.message).toContain("своя норма ставится только после расчёта поддержания");
  });

  it("draws the day card from the database's numbers", async () => {
    const { owner } = await family();
    await foodLogRepository.execute(owner, kefir(), key());
    const summary = (await buildHealthSummary(
      owner,
      noWorkspace,
      { action: "day", date: "2026-11-09" },
      key(),
    )) as { day: DaySummary };
    expect(summary.day.eaten.kcal).toBe(100);
    const html = renderDayCard(summary.day, "progress");
    expect(html).toContain("<b>100</b><small>ккал съедено</small>");
    expect(html).toContain(
      '<span class="m">08:00</span><span class="x">Кефир</span><span class="v">100</span>',
    );
  });
});
