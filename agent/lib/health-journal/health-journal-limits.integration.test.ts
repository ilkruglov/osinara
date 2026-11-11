/**
 * Health journal limits against PostgreSQL: the second review round of 11 November 2026.
 *
 * Constructs covered:
 * - Many journal calls at once finish: one operation never holds two pool connections.
 * - A deficit block is lifted on its own, never in the call that sets weight loss.
 * - A time later than now today is the future too.
 * - Correcting steps drops the distance that belonged to the old steps.
 * - The weekly check counts food logged before the first weigh-in.
 * - One date has one trend weight and one target in the day and the week summary.
 * - An own target follows the stricter floor while the sex is unknown, and below resting
 *   expenditure it is kept with a warning.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { bodyProfileRepository } from "./body-profile-repository.js";
import { foodLogRepository } from "./food-log-repository.js";
import { addDays } from "./health-formulas.js";
import {
  createHealthFamily,
  failureOf,
  nextOperationKey,
  noWorkspace,
} from "./health-journal.integration-fixtures.js";
import { buildHealthSummary } from "./health-summary.js";
import type { DaySummary, WeekSummary } from "./health-summary-data.js";
import { sleepActivityRepository } from "./sleep-activity-repository.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const key = nextOperationKey;

async function moscowToday(): Promise<{ now: string; today: string }> {
  const result = await database().query<{ now: string; today: string }>(
    `SELECT (now() AT TIME ZONE 'Europe/Moscow')::date::text AS today,
            to_char(now() AT TIME ZONE 'Europe/Moscow', 'HH24:MI') AS now`,
  );
  return result.rows[0]!;
}

describeWithDatabase("health journal limits", () => {
  afterAll(closeDatabase);

  it("finishes many calls at once without holding two pool connections each", async () => {
    const { owner } = await createHealthFamily();
    const calls = Array.from({ length: 24 }, () =>
      foodLogRepository.execute(owner, { action: "day" }, key()),
    );
    const settled = await Promise.race([
      Promise.all(calls).then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 15_000)),
    ]);
    expect(settled).toBe("done");
  }, 30_000);

  it("lifts a deficit block only on its own", async () => {
    const { owner } = await createHealthFamily();
    const created = (await bodyProfileRepository.execute(
      owner,
      { action: "set_profile", deficitBlock: "eating_disorder", goal: "maintain" },
      key(),
    )) as { profile: { version: number } };
    const together = await failureOf(
      bodyProfileRepository.execute(
        owner,
        {
          action: "set_profile",
          deficitBlock: null,
          goal: "lose",
          version: created.profile.version,
        },
        key(),
      ),
    );
    expect(together.code).toBe("AGENT_HEALTH_DEFICIT_NOT_ALLOWED");
    const lifted = (await bodyProfileRepository.execute(
      owner,
      { action: "set_profile", deficitBlock: null, version: created.profile.version },
      key(),
    )) as { profile: { deficitBlock: string | null } };
    expect(lifted.profile.deficitBlock).toBeNull();
  });

  it("refuses a time later than now today", async () => {
    const { owner } = await createHealthFamily();
    const { now, today } = await moscowToday();
    if (now >= "23:58") return; // nothing later than now is left today
    const later = now < "23:00" ? "23:30" : "23:59";
    const meal = await failureOf(
      foodLogRepository.execute(
        owner,
        {
          action: "add",
          date: today,
          estimateSource: "described",
          items: [
            {
              amount: 100,
              name: "Ужин",
              per100: { carbs: 1, fat: 1, fiber: 0, kcal: 100, protein: 1 },
              unit: "g",
            },
          ],
          time: later,
          title: "Ужин",
        },
        key(),
      ),
    );
    expect(meal.code).toBe("AGENT_HEALTH_DATE_IN_FUTURE");
    const night = await failureOf(
      sleepActivityRepository.execute(
        owner,
        { action: "log_sleep", bedtime: "00:30", source: "text", wakeDate: today, wakeTime: later },
        key(),
      ),
    );
    expect(night.code).toBe("AGENT_HEALTH_DATE_IN_FUTURE");
  });

  it("drops the imported distance when the steps are corrected", async () => {
    const { owner } = await createHealthFamily();
    await sleepActivityRepository.importZepp(
      owner,
      { contentSha256: "sha", path: "p", since: null },
      {
        activity: [{ date: "2026-10-01", distanceM: 8000, steps: 10000 }],
        sleep: [],
        weighIns: [],
      },
      key(),
    );
    const corrected = await sleepActivityRepository.execute(
      owner,
      { action: "log_activity", date: "2026-10-01", source: "text", steps: 1000 },
      key(),
    );
    expect(corrected).toMatchObject({ activity: { distanceM: null, source: "text", steps: 1000 } });
  });

  it("counts food logged before the first weigh-in in the weekly check", async () => {
    const { familyId, owner } = await createHealthFamily();
    await bodyProfileRepository.execute(
      owner,
      {
        action: "set_profile",
        activityLevel: "light",
        birthDate: "1990-01-01",
        goal: "maintain",
        heightCm: 170,
        sex: "female",
      },
      key(),
    );
    const { today } = await moscowToday();
    await database().query(
      `INSERT INTO health_food_entries (family_id, owner_user_id, eaten_at, local_date, title,
         estimate_source, items, kcal, protein_g, fat_g, carbs_g, fiber_g)
       SELECT $1, $2, g.day::date + time '12:00', g.day::date, 'Обед', 'weighed', '[{"x":1}]', 2000, 100, 70, 230, 20
         FROM generate_series($3::date - 21, $3::date - 1, interval '1 day') AS g(day)`,
      [familyId, owner.userId, today],
    );
    // The first weigh-in comes on the third day of the window.
    await database().query(
      `INSERT INTO health_body_measurements (family_id, owner_user_id, measured_at, local_date, weight_kg, source)
       SELECT $1, $2, g.day::date + time '08:00', g.day::date, 65, 'text'
         FROM generate_series($3::date - 19, $3::date - 1, interval '1 day') AS g(day)`,
      [familyId, owner.userId, today],
    );
    const week = (await buildHealthSummary(owner, noWorkspace, { action: "week" }, key())) as {
      weeklyCheck: { status: string };
    };
    expect(week.weeklyCheck.status).toBe("ok");
  });

  it("gives one date one target in the day and the week summary", async () => {
    const { familyId, owner } = await createHealthFamily();
    await bodyProfileRepository.execute(
      owner,
      {
        action: "set_profile",
        activityLevel: "moderate",
        birthDate: "1985-05-05",
        goal: "lose",
        heightCm: 180,
        sex: "male",
      },
      key(),
    );
    const { today } = await moscowToday();
    // Weekly weigh-ins over a year: with a 120-day window the weigh-in 126 days back seeded the
    // day's trend but not the week's, which starts six days later.
    await database().query(
      `INSERT INTO health_body_measurements (family_id, owner_user_id, measured_at, local_date, weight_kg, source)
       SELECT $1, $2, ($3::date - n * 7) + time '08:00', $3::date - n * 7, CASE WHEN n = 18 THEN 120 ELSE 80 END, 'text'
         FROM generate_series(1, 52) AS n`,
      [familyId, owner.userId, today],
    );
    const date = addDays(today, -10);
    const day = (await buildHealthSummary(owner, noWorkspace, { action: "day", date }, key())) as {
      day: DaySummary;
    };
    const week = (await buildHealthSummary(
      owner,
      noWorkspace,
      { action: "week", date: addDays(date, 6) },
      key(),
    )) as { week: WeekSummary };
    expect(week.week.days.find((item) => item.date === date)?.targetKcal).toBe(
      day.day.targets.kcal,
    );
  });

  it("holds an own target to the stricter floor and warns below resting expenditure", async () => {
    const { owner } = await createHealthFamily();
    const unknownSex = await failureOf(
      bodyProfileRepository.execute(owner, { action: "set_profile", kcalTarget: 1300 }, key()),
    );
    expect(unknownSex.code).toBe("AGENT_HEALTH_TARGET_TOO_LOW");
    const created = (await bodyProfileRepository.execute(
      owner,
      {
        action: "set_profile",
        activityLevel: "moderate",
        birthDate: "1990-01-01",
        goal: "lose",
        heightCm: 190,
        sex: "male",
      },
      key(),
    )) as { profile: { version: number } };
    await bodyProfileRepository.execute(
      owner,
      { action: "log_measurement", source: "text", weightKg: 100 },
      key(),
    );
    const own = (await bodyProfileRepository.execute(
      owner,
      { action: "set_profile", kcalTarget: 1600, version: created.profile.version },
      key(),
    )) as unknown as { targets: { kcal: number }; warnings: string[] };
    expect(own.targets.kcal).toBe(1600);
    expect(own.warnings.join(" ")).toContain("ниже обмена в покое");
  });
});
