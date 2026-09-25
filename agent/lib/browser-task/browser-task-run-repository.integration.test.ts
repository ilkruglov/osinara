/**
 * Browser task run repository integration tests.
 *
 * Constructs covered:
 * - A run is created running, progress is saved and read back, the active run of a sandbox is found.
 * - Another user of the family cannot read the run; a finished run is no longer active.
 * - A confirm is claimed once; the claimed run stays active.
 * - The form profile belongs to one person: fields add up under concurrent writes, a card field is
 *   refused, another member reads nothing.
 */
import { afterAll, describe, expect, it } from "vitest";

import { database } from "../database.js";
import { createBrowserTaskRunRepository } from "./browser-task-run-repository.js";
import { createFormProfileRepository } from "./form-profile-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (integrationTestsEnabled) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  if (!new URL(url).pathname.slice(1).endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
  }
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

async function fixture(suffix: string): Promise<{ familyId: string; userId: string; otherUserId: string }> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Browser family ${suffix}`]);
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Owner'), ($2, 'Member') RETURNING id, telegram_user_id`,
    [`browser-owner-${suffix}`, `browser-member-${suffix}`],
  );
  const owner = users.rows.find((row) => row.telegram_user_id === `browser-owner-${suffix}`)!;
  const member = users.rows.find((row) => row.telegram_user_id === `browser-member-${suffix}`)!;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, owner.id, member.id],
  );
  return { familyId: family.rows[0]!.id, otherUserId: member.id, userId: owner.id };
}

describeWithDatabase("browserTaskRunRepository", () => {
  afterAll(async () => {
    await database().end();
  });

  it("creates a run, saves progress and finds the active run of a sandbox", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, otherUserId, userId } = await fixture(suffix);
    const repo = createBrowserTaskRunRepository();
    const sandbox = `sbx-${suffix}`;

    const run = await repo.create({
      allowedFields: ["name"], extraData: { phone: "+7" }, familyId, goal: "записаться",
      sandboxSessionId: sandbox, scope: "personal", startUrl: "https://b-frant.ru", userId,
    });
    expect(run.status).toBe("running");
    expect(run.extraData).toEqual({ phone: "+7" });

    run.stepCount = 3;
    run.history = [{ action: "CLICK [1]", confidence: 0.9, url: "https://b-frant.ru/" }];
    run.entered = [{ field: "name", label: "Введите имя" }];
    run.failedActions = { "CLICK:e7": 2 };
    run.status = "awaiting_confirmation";
    run.pendingAction = { label: "Записаться", pageHash: "h", ref: "e7", role: "button", url: "https://b-frant.ru/book" };
    run.allowedFields = ["name", "phone"];
    run.activeMillis = 12_345;
    await repo.save(run);

    expect(await repo.activeForSandbox(sandbox)).toMatchObject({ id: run.id, pendingAction: { ref: "e7" }, stepCount: 3 });
    expect(await repo.get(run.id, { familyId, userId })).toMatchObject({ entered: [{ field: "name", label: "Введите имя" }], failedActions: { "CLICK:e7": 2 } });
    expect(await repo.get(run.id, { familyId, userId: otherUserId })).toBeNull();
    expect(await repo.get(run.id, { familyId, userId })).toMatchObject({ activeMillis: 12_345, allowedFields: ["name", "phone"] });

    // Only one confirm leaves awaiting_confirmation; the claimed run stays active and busy.
    expect(await repo.transition(run.id, "awaiting_confirmation", "confirming")).toBe(true);
    expect(await repo.transition(run.id, "awaiting_confirmation", "confirming")).toBe(false);
    expect(await repo.activeForSandbox(sandbox)).toMatchObject({ id: run.id, status: "confirming" });

    run.status = "done";
    await repo.save(run);
    expect(await repo.activeForSandbox(sandbox)).toBeNull();
  });

  it("keeps one form profile per person and adds concurrent fields without losing either", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, otherUserId, userId } = await fixture(suffix);
    const profiles = createFormProfileRepository();
    const owner = { familyId, userId };

    expect(await profiles.get(owner)).toBeNull();
    await Promise.all([
      profiles.upsertField(owner, { domains: ["yclients.com"], field: "phone", value: "+79160000000" }),
      profiles.upsertField(owner, { domains: ["*"], field: "name", value: "Илья" }, async () => ({ email: { domains: ["*"], value: "a@b.ru" } })),
    ]);
    const stored = await profiles.get(owner);
    expect(stored).toMatchObject({ name: { value: "Илья" }, phone: { domains: ["yclients.com"], value: "+79160000000" } });

    await expect(profiles.upsertField(owner, { domains: ["*"], field: "cvc", value: "123" })).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_PROFILE_INVALID" });
    expect(await profiles.get({ familyId, userId: otherUserId })).toBeNull();
  });
});
