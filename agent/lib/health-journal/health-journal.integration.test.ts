/**
 * Health journal repositories against PostgreSQL.
 *
 * Constructs covered:
 * - One person's food entries: totals from the composition, versions, replay by call id, soft
 *   removal; another member, a family group and a revoked membership see and change nothing.
 * - Civil days: a meal at 00:30 in Vladivostok is the new day; no timezone at all is a named error.
 * - Goal safety in code: a minor or a deficit block refuses weight loss, a target below the floor
 *   is refused.
 * - Sleep: one night per wake date, replacing it needs its version.
 * - Zepp import: counts, a second import adds nothing, a night typed in the chat is kept.
 * - Workouts: tonnage, and an exercise's history across spellings.
 * - Summaries: the day's numbers are the database sums; the weekly check proposes a correction from
 *   three weeks of data, and only that number can be applied.
 * - erase_all removes one person's journal and nobody else's.
 */
import { readFileSync } from "node:fs";

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
import { buildHealthSummary } from "./health-summary.js";
import { sleepActivityRepository } from "./sleep-activity-repository.js";
import { workoutRepository } from "./workout-repository.js";
import { parseZeppExport } from "./zepp-export.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const RICE = { carbs: 28.2, fat: 0.3, fiber: 0.4, kcal: 130, protein: 2.7 };
const CHICKEN = { carbs: 0, fat: 3.6, fiber: 0, kcal: 165, protein: 31 };
const WATER = { carbs: 0, fat: 0, fiber: 0, kcal: 0, protein: 0 };

const key = nextOperationKey;
const family = createHealthFamily;
const codeOf = async (promise: Promise<unknown>) => (await failureOf(promise)).code;

describeWithDatabase("health journal", () => {
  afterAll(closeDatabase);

  it("keeps one person's food with computed totals, versions and replays", async () => {
    const fixture = await family("Europe/Moscow");
    const owner = fixture.owner;
    const member = fixture.member;
    const input = {
      action: "add" as const,
      date: "2026-11-09",
      estimateSource: "weighed" as const,
      items: [
        { amount: 200, name: "Рис", per100: RICE, unit: "g" as const },
        { amount: 150, name: "Курица", per100: CHICKEN, unit: "g" as const },
        { amount: 300, countsAsWater: true, name: "Вода", per100: WATER, unit: "ml" as const },
      ],
      time: "13:30",
      title: "Рис с курицей",
    };
    const added = (await foodLogRepository.execute(owner, input, "food-1")) as {
      dayTotals: Record<string, number>;
      entry: { id: string; kcal: number; protein: number; version: number; waterMl: number };
      replayed: boolean;
    };
    expect(added.entry).toMatchObject({ kcal: 507.5, protein: 51.9, version: 1, waterMl: 300 });
    expect(added.dayTotals).toMatchObject({ entries: 1, kcal: 507.5, waterMl: 300 });
    const replay = await foodLogRepository.execute(owner, input, "food-1");
    expect(replay).toMatchObject({ entry: { id: added.entry.id }, replayed: true });
    expect(
      await codeOf(foodLogRepository.execute(owner, { ...input, title: "Другое" }, "food-1")),
    ).toBe("AGENT_HEALTH_OPERATION_REUSED");

    // Another member: no entries, no access by id, and they have no timezone of their own (the
    // owner's applies).
    expect(
      await foodLogRepository.execute(member, { action: "day", date: "2026-11-09" }, key()),
    ).toMatchObject({
      entries: [],
    });
    expect(
      await codeOf(foodLogRepository.execute(member, { action: "get", id: added.entry.id }, key())),
    ).toBe("AGENT_HEALTH_RECORD_NOT_FOUND");
    expect(
      await codeOf(
        foodLogRepository.execute(
          { ...owner, groupId: crypto.randomUUID() },
          { action: "day" },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_ACCESS_DENIED");

    // Correction recomputes from the composition; a stale version is refused.
    const updated = (await foodLogRepository.execute(
      owner,
      {
        action: "update",
        id: added.entry.id,
        items: [{ amount: 120, name: "Рис", per100: RICE, unit: "g" }],
        version: 1,
      },
      key(),
    )) as { entry: { kcal: number; version: number } };
    expect(updated.entry).toMatchObject({ kcal: 156, version: 2 });
    expect(
      await codeOf(
        foodLogRepository.execute(
          owner,
          { action: "remove", id: added.entry.id, version: 1 },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_VERSION_STALE");
    await foodLogRepository.execute(
      owner,
      { action: "remove", id: added.entry.id, version: 2 },
      key(),
    );
    expect(
      await foodLogRepository.execute(owner, { action: "day", date: "2026-11-09" }, key()),
    ).toMatchObject({
      entries: [],
      totals: { kcal: 0 },
    });

    await database().query("DELETE FROM family_memberships WHERE user_id = $1", [member.userId]);
    expect(await codeOf(foodLogRepository.execute(member, { action: "day" }, key()))).toBe(
      "AGENT_HEALTH_ACCESS_DENIED",
    );
  });

  it("files a meal under the person's civil day and names a missing timezone", async () => {
    const fixture = await family("Asia/Vladivostok");
    const owner = fixture.owner;
    await foodLogRepository.execute(
      owner,
      {
        action: "add",
        date: "2026-11-10",
        estimateSource: "described",
        items: [
          {
            amount: 100,
            name: "Кефир",
            per100: { carbs: 4, fat: 1, fiber: 0, kcal: 40, protein: 3 },
            unit: "ml",
          },
        ],
        time: "00:30",
        title: "Кефир",
      },
      key(),
    );
    const stored = await database().query<{ local_date: string; utc_date: string }>(
      `SELECT local_date::text, (eaten_at AT TIME ZONE 'UTC')::date::text AS utc_date
         FROM health_food_entries WHERE owner_user_id = $1`,
      [owner.userId],
    );
    expect(stored.rows[0]).toEqual({ local_date: "2026-11-10", utc_date: "2026-11-09" });

    const bare = await family(null);
    expect(await codeOf(foodLogRepository.execute(bare.owner, { action: "day" }, key()))).toBe(
      "AGENT_HEALTH_TIMEZONE_MISSING",
    );
  });

  it("refuses unsafe goals in code", async () => {
    const owner = (await family("Europe/Moscow")).owner;
    expect(
      await codeOf(
        bodyProfileRepository.execute(
          owner,
          { action: "set_profile", birthDate: "2012-05-01", goal: "lose" },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_DEFICIT_NOT_ALLOWED");
    expect(
      await codeOf(
        bodyProfileRepository.execute(
          owner,
          { action: "set_profile", deficitBlock: "pregnancy", goal: "lose" },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_DEFICIT_NOT_ALLOWED");
    expect(
      await codeOf(
        bodyProfileRepository.execute(
          owner,
          { action: "set_profile", kcalTarget: 1000, sex: "female" },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_TARGET_TOO_LOW");
    const created = (await bodyProfileRepository.execute(
      owner,
      {
        action: "set_profile",
        activityLevel: "moderate",
        birthDate: "1986-11-11",
        goal: "lose",
        heightCm: 180,
        sex: "male",
        weeklyRateKg: 0.5,
      },
      key(),
    )) as { profile: { version: number }; targets: { missing: string[] } };
    expect(created.targets.missing).toEqual(["weight"]);
    await bodyProfileRepository.execute(
      owner,
      { action: "log_measurement", source: "text", weightKg: 80 },
      key(),
    );
    const read = (await bodyProfileRepository.execute(owner, { action: "get" }, key())) as {
      profile: { version: number };
      targets: { kcal: number; proteinG: number };
    };
    expect(read.targets.proteinG).toBe(128);
    expect(read.targets.kcal).toBeGreaterThan(1730);
    expect(
      await codeOf(
        bodyProfileRepository.execute(owner, { action: "set_profile", goal: "maintain" }, key()),
      ),
    ).toBe("AGENT_HEALTH_VERSION_STALE");
    expect(
      await codeOf(
        bodyProfileRepository.execute(
          owner,
          { action: "set_profile", deficitBlock: "medical", version: read.profile.version },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_DEFICIT_NOT_ALLOWED");
  });

  it("keeps one night per wake date and imports Zepp without overwriting the chat", async () => {
    const owner = (await family("Europe/Moscow")).owner;
    const night = await sleepActivityRepository.execute(
      owner,
      {
        action: "log_sleep",
        awakeMin: 20,
        bedtime: "23:40",
        source: "text",
        wakeDate: "2026-10-03",
        wakeTime: "07:10",
      },
      key(),
    );
    expect(night).toMatchObject({
      sleep: { bedtime: "23:40", totalMin: 430, version: 1, wakeTime: "07:10" },
    });
    expect(
      await codeOf(
        sleepActivityRepository.execute(
          owner,
          { action: "log_sleep", source: "text", totalMin: 400, wakeDate: "2026-10-03" },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_SLEEP_EXISTS");

    const data = parseZeppExport(
      readFileSync(
        new URL("../../../test/fixtures/health-journal/zepp-export-aes.zip", import.meta.url),
      ),
      "Zepp-2026",
    );
    const source = { contentSha256: "sha", path: "inbox/1/export.zip", since: null };
    const first = await sleepActivityRepository.importZepp(owner, source, data, key());
    expect(first).toMatchObject({
      activity: { added: 2, kept: 0, refreshed: 0 },
      period: { from: "2026-10-01", to: "2026-10-03" },
      sleep: { added: 1, kept: 1, refreshed: 0 },
      weighIns: { added: 2 },
    });
    const second = await sleepActivityRepository.importZepp(owner, source, data, key());
    expect(second).toMatchObject({
      activity: { added: 0, kept: 2 },
      sleep: { added: 0, kept: 2 },
      weighIns: { added: 0 },
    });
    const listed = (await sleepActivityRepository.execute(
      owner,
      { action: "list", from: "2026-10-01", to: "2026-10-03" },
      key(),
    )) as {
      activity: unknown[];
      sleep: Array<{ source: string; totalMin: number; wakeDate: string }>;
    };
    expect(listed.activity).toHaveLength(2);
    expect(listed.sleep).toEqual([
      expect.objectContaining({ source: "zepp", totalMin: 450, wakeDate: "2026-10-01" }),
      expect.objectContaining({ source: "text", totalMin: 430, wakeDate: "2026-10-03" }),
    ]);
  });

  it("sums strength sets and follows an exercise across spellings", async () => {
    const owner = (await family("Europe/Moscow")).owner;
    const add = (date: string, name: string, weight: number) =>
      workoutRepository.execute(
        owner,
        {
          action: "add",
          date,
          durationMin: 60,
          exercises: [
            {
              name,
              sets: [
                { reps: 10, weightKg: weight },
                { reps: 8, weightKg: weight + 5 },
              ],
            },
          ],
          intensity: "moderate",
          kind: "strength",
          title: "Зал",
        },
        key(),
      );
    expect(await add("2026-11-02", "Жим лёжа", 40)).toMatchObject({
      workout: { setCount: 2, tonnageKg: 760 },
    });
    await add("2026-11-09", "жим  лежа", 45);
    expect(
      await workoutRepository.execute(owner, { action: "progress", exercise: "ЖИМ ЛЁЖА" }, key()),
    ).toMatchObject({
      history: [
        { date: "2026-11-09", maxWeightKg: 50 },
        { date: "2026-11-02", maxWeightKg: 45 },
      ],
      recordWeightKg: 50,
    });
  });

  it("summarizes the database's numbers and applies only the proposed correction", async () => {
    const fixture = await family("Europe/Moscow");
    const owner = fixture.owner;
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
    const today = (
      await database().query<{ today: string }>(
        "SELECT (now() AT TIME ZONE 'Europe/Moscow')::date::text AS today",
      )
    ).rows[0]!.today;
    // Three weeks of 2000 kcal and a stable 65 kg, inserted directly: the check, not the tools, is tested here.
    await database().query(
      `INSERT INTO health_food_entries (family_id, owner_user_id, eaten_at, local_date, title,
         estimate_source, items, kcal, protein_g, fat_g, carbs_g, fiber_g)
       SELECT $1, $2, g.day::date + time '12:00', g.day::date, 'Обед', 'weighed', '[{"x":1}]', 2000, 100, 70, 230, 20
         FROM generate_series($3::date - 21, $3::date - 1, interval '1 day') AS g(day)`,
      [fixture.familyId, owner.userId, today],
    );
    await database().query(
      `INSERT INTO health_body_measurements (family_id, owner_user_id, measured_at, local_date, weight_kg, source)
       SELECT $1, $2, g.day::date + time '08:00', g.day::date, 65, 'text'
         FROM generate_series($3::date - 40, $3::date - 1, interval '1 day') AS g(day)`,
      [fixture.familyId, owner.userId, today],
    );
    const day = (await buildHealthSummary(
      owner,
      noWorkspace,
      { action: "day", card: true, date: today },
      key(),
    )) as {
      card: null;
      day: { eaten: { kcal: number }; remainingKcal: number; targets: { kcal: number } };
    };
    expect(day.card).toBeNull();
    expect(day.day.eaten.kcal).toBe(0);
    expect(day.day.remainingKcal).toBe(day.day.targets.kcal);

    const week = (await buildHealthSummary(owner, noWorkspace, { action: "week" }, key())) as {
      week: { averages: { kcal: number }; loggedDays: number };
      weeklyCheck: { observedKcal: number; proposedAdjustmentKcal: number; status: string };
    };
    expect(week.week.loggedDays).toBe(6);
    expect(week.week.averages.kcal).toBe(2000);
    expect(week.weeklyCheck).toMatchObject({ observedKcal: 2000, status: "ok" });
    const proposed = week.weeklyCheck.proposedAdjustmentKcal;
    expect(proposed).not.toBeNull();

    const profile = (await bodyProfileRepository.execute(owner, { action: "get" }, key())) as {
      profile: { version: number };
    };
    expect(
      await codeOf(
        bodyProfileRepository.execute(
          owner,
          {
            action: "apply_adjustment",
            adjustmentKcal: proposed + 50,
            version: profile.profile.version,
          },
          key(),
        ),
      ),
    ).toBe("AGENT_HEALTH_ADJUSTMENT_STALE");
    const applied = await bodyProfileRepository.execute(
      owner,
      { action: "apply_adjustment", adjustmentKcal: proposed, version: profile.profile.version },
      key(),
    );
    expect(applied).toMatchObject({ profile: { expenditureAdjustmentKcal: proposed } });

    // Erasing one person's journal leaves another family's journal alone.
    const other = (await family("Europe/Moscow")).owner;
    await bodyProfileRepository.execute(
      other,
      { action: "log_measurement", source: "text", weightKg: 70 },
      key(),
    );
    const erased = (await bodyProfileRepository.execute(owner, { action: "erase_all" }, key())) as {
      erased: Record<string, number>;
    };
    expect(erased.erased).toMatchObject({
      health_body_measurements: 40,
      health_food_entries: 21,
      health_profiles: 1,
    });
    const left = await database().query<{ owner: string; rows: string }>(
      `SELECT owner_user_id::text AS owner, count(*)::text AS rows FROM health_body_measurements
        WHERE owner_user_id = ANY($1::uuid[]) GROUP BY owner_user_id`,
      [[owner.userId, other.userId]],
    );
    expect(left.rows).toEqual([{ owner: other.userId, rows: "1" }]);
  });
});
