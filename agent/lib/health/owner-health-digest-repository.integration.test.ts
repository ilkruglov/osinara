/**
 * Owner health digest repository tests (PostgreSQL).
 *
 * Constructs covered:
 * - The family owner with a Telegram id is a recipient.
 * - The report counts a rotation, written memory and a stuck review lane of that family only.
 * - Failed and ambiguous scheduled runs of the window are named by schedule, except another
 *   member's personal schedule, which is only counted; older runs and other families are left out.
 * - The daily claim is taken once; a released claim can be taken again; a completed one cannot.
 * - A completed digest records the balance the next one reads back; the balance alert claim
 *   follows the same day rule, and an abandoned one is never taken again that day.
 * - Both databases have a measurable size.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMemoryFamilyFixture, createMemoryInput } from "../memory-repository.integration-fixtures.js";
import { memoryRepository } from "../memory-repository.js";
import { ownerBalanceAlertRepository } from "./owner-balance-alert-repository.js";
import { ownerHealthDigestRepository } from "./owner-health-digest-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("ownerHealthDigestRepository", () => {
  afterAll(closeDatabase);

  it("reports the family's rotations, memory and stuck lanes, and claims the day once", async () => {
    const suffix = `health-${Date.now()}`;
    const family = await createMemoryFamilyFixture(suffix);
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60 * 60 * 1_000);

    const recipients = await ownerHealthDigestRepository.recipients();
    expect(recipients).toContainEqual({ familyId: family.familyId, ownerTelegramUserId: `owner-${suffix}` });

    await memoryRepository.create(family.owner, createMemoryInput("family", `${suffix}-fact`, "Семья любит гречку"));
    await database().query(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, conversation_key, continuation_token,
          started_at, last_activity_at, rotation_requested_at, kind)
       VALUES (gen_random_uuid(), 0, $1, $2, 'personal', $3, $4, now(), now(), now(), 'canonical')`,
      [family.familyId, family.owner.userId, `key-${suffix}`, `token-${suffix}`],
    );
    // Writing memory may already have created the owner's personal conversation; reuse it.
    await database().query(
      `INSERT INTO application_conversations
         (family_id, owner_user_id, telegram_chat_id, scope, scope_partition_key, label)
       VALUES ($1, $2, $3, 'personal', $2, $4) ON CONFLICT DO NOTHING`,
      [family.familyId, family.owner.userId, `chat-${suffix}`, `Личный чат ${suffix}`],
    );
    const conversation = await database().query<{ id: string; label: string }>(
      `SELECT id, label FROM application_conversations
        WHERE family_id = $1 AND scope = 'personal' AND owner_user_id = $2`,
      [family.familyId, family.owner.userId],
    );
    const label = conversation.rows[0]!.label;
    const lane = await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, processed_through_sequence)
       VALUES ($1, 10) RETURNING id`,
      [conversation.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
          through_sequence, source_count, diagnostic_code, started_at, completed_at)
       VALUES ($1, $2, 'background', 'failed', 10, 11, 12, 2, 'MODEL_CALL_FAILED', now(), now())`,
      [lane.rows[0]!.id, conversation.rows[0]!.id],
    );

    const report = await ownerHealthDigestRepository.report(family.familyId, windowStart, now);
    expect(report.rotations.count).toBe(1);
    expect(report.memoryWritten).toContainEqual(expect.objectContaining({ count: 1, scope: "family" }));
    expect(report.lanes.blocked).toContainEqual({
      code: "MODEL_CALL_FAILED", headStatus: "failed", label, waiting: 0,
    });
    expect(report.reviewBatches.failed).toBe(1);

    const digestDate = "2026-09-09";
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(true);
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(false);
    await ownerHealthDigestRepository.release(family.familyId, digestDate);
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(true);
    await ownerHealthDigestRepository.complete(family.familyId, digestDate, now, 42);
    await ownerHealthDigestRepository.release(family.familyId, digestDate);
    await expect(ownerHealthDigestRepository.claim(family.familyId, digestDate, now)).resolves.toBe(false);
  });

  it("reports the family's failed scheduled runs in the window, naming only schedules the owner may see", async () => {
    const suffix = `schedule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const family = await createMemoryFamilyFixture(suffix);
    const other = await createMemoryFamilyFixture(`${suffix}-other`);
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60 * 60 * 1_000);
    const group = await database().query<{ id: string }>(
      "SELECT id FROM telegram_groups WHERE family_id = $1",
      [family.familyId],
    );
    async function schedule(
      familyId: string,
      scope: "family" | "personal",
      title: string,
      ownerUserId: string | null,
      groupId: string | null,
    ): Promise<string> {
      const result = await database().query<{ id: string }>(
        `INSERT INTO agent_schedules
           (family_id, owner_user_id, author_user_id, group_id, scope, title, user_request, scenario_prompt,
            timezone, recurrence_kind, recurrence_interval, recurrence_anchor_local, next_run_at,
            telegram_chat_id, telegram_chat_type)
         VALUES ($1, $2::uuid, COALESCE($2::uuid, $3::uuid), $4, $5, $6, 'Запрос', 'Сценарий', 'UTC', 'daily', 1,
                 timestamp '2026-01-01 00:00:00', timestamptz '2026-01-01 00:00:00+00', $7, $8)
         RETURNING id`,
        [familyId, ownerUserId, family.owner.userId, groupId, scope, title,
          `chat-${title}-${suffix}`, scope === "personal" ? "private" : "supergroup"],
      );
      return result.rows[0]!.id;
    }
    let occurrence = 0;
    async function run(scheduleId: string, familyId: string, status: string, code: string | null, updatedAt: Date) {
      occurrence += 1;
      await database().query(
        `INSERT INTO agent_schedule_runs (schedule_id, family_id, scheduled_for, status, lease_token, error_code, updated_at)
         VALUES ($1, $2, timestamptz '2026-01-01 00:00:00+00' + $6 * interval '1 minute', $3, gen_random_uuid(), $4, $5)`,
        [scheduleId, familyId, status, code, updatedAt, occurrence],
      );
    }
    const ownerOwn = await schedule(family.familyId, "personal", "Мои новости", family.owner.userId, null);
    const memberOwn = await schedule(family.familyId, "personal", "Тайна участника", family.member.userId, null);
    const familyWide = await schedule(family.familyId, "family", "Семейный план", null, group.rows[0]!.id);
    const foreign = await schedule(other.familyId, "personal", "Чужая семья", other.owner.userId, null);
    await run(ownerOwn, family.familyId, "failed", "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING", now);
    await run(ownerOwn, family.familyId, "failed", "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING", now);
    await run(ownerOwn, family.familyId, "completed", null, now);
    await run(ownerOwn, family.familyId, "failed", "OLD_FAILURE", new Date(windowStart.getTime() - 60_000));
    await run(familyWide, family.familyId, "ambiguous", "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", now);
    await run(memberOwn, family.familyId, "failed", "AGENT_SCHEDULE_DESTINATION_REVOKED", now);
    await run(foreign, other.familyId, "failed", "FOREIGN_FAILURE", now);

    const report = await ownerHealthDigestRepository.report(family.familyId, windowStart, now);

    expect(report.scheduleFailures).toEqual({
      count: 4,
      hiddenPersonal: 1,
      otherSchedules: { count: 0, schedules: 0 },
      schedules: [
        {
          codes: [{ code: "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING", count: 2 }],
          count: 2,
          otherCodes: 0,
          title: "Мои новости",
        },
        { codes: [{ code: "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", count: 1 }], count: 1, otherCodes: 0, title: "Семейный план" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("Тайна участника");
  });

  it("records the balance of a sent digest, claims the balance alert once a day and sizes the databases", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const family = await createMemoryFamilyFixture(suffix);
    const now = new Date("2026-09-26T06:10:00.000Z");
    expect(await ownerHealthDigestRepository.previousBalance(family.familyId, "2026-09-27")).toBeNull();
    expect(await ownerHealthDigestRepository.claim(family.familyId, "2026-09-26", now)).toBe(true);
    await ownerHealthDigestRepository.complete(family.familyId, "2026-09-26", now, 120, 12.5);
    // Only yesterday's balance makes a day's change: a gap of a day yields no comparison.
    expect(await ownerHealthDigestRepository.previousBalance(family.familyId, "2026-09-27")).toBe(12.5);
    expect(await ownerHealthDigestRepository.previousBalance(family.familyId, "2026-09-28")).toBeNull();

    expect(await ownerBalanceAlertRepository.claim(family.familyId, "2026-09-26", now)).toBe(true);
    expect(await ownerBalanceAlertRepository.claim(family.familyId, "2026-09-26", now)).toBe(false);
    await ownerBalanceAlertRepository.release(family.familyId, "2026-09-26");
    expect(await ownerBalanceAlertRepository.claim(family.familyId, "2026-09-26", now)).toBe(true);
    await ownerBalanceAlertRepository.abandon(family.familyId, "2026-09-26", "AGENT_OWNER_BALANCE_ALERT_AMBIGUOUS");
    await ownerBalanceAlertRepository.release(family.familyId, "2026-09-26");
    expect(await ownerBalanceAlertRepository.claim(family.familyId, "2026-09-26", now)).toBe(false);
    // A claim left behind by a dead dispatcher is ambiguous, not free: the alert is not sent twice.
    expect(await ownerBalanceAlertRepository.claim(family.familyId, "2026-09-27", now)).toBe(true);
    expect(await ownerBalanceAlertRepository.claim(family.familyId, "2026-09-27", new Date(now.getTime() + 2 * 60 * 60 * 1_000))).toBe(false);

    expect(await ownerHealthDigestRepository.databaseBytes()).toBeGreaterThan(0);
  });
});
