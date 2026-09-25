/**
 * Browser task run repository integration tests.
 *
 * Constructs covered:
 * - A run is created running, progress is saved and read back, the active run of a sandbox is found.
 * - Another user of the family cannot read the run; a finished run is no longer active.
 * - A confirm is claimed once; the claimed run stays active. allowField touches one column of an
 *   active run only. A finished run forgets typed values.
 * - The form profile belongs to one person: fields add up under concurrent writes, a card field is
 *   refused, another member reads nothing, a removed member reads and writes nothing, and the old
 *   profile file is folded in once without overwriting newer fields.
 * - From a group the profile opens only while that group is still a family group of that family.
 * - A person who moved to another family starts a new profile there; the old one stays behind.
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
    run.entered = [{ field: "name", label: "Введите имя", value: "Иван" }];
    run.failedActions = { "CLICK:e7": 2 };
    run.status = "awaiting_confirmation";
    run.pendingAction = { label: "Записаться", pageHash: "h", ref: "e7", role: "button", url: "https://b-frant.ru/book" };
    run.activeMillis = 12_345;
    await repo.save(run);
    expect(await repo.allowField(run.id, "phone")).toBe(true);
    expect(await repo.allowField(run.id, "phone")).toBe(true);

    expect(await repo.activeForSandbox(sandbox)).toMatchObject({ id: run.id, pendingAction: { ref: "e7" }, stepCount: 3 });
    expect(await repo.get(run.id, { familyId, userId })).toMatchObject({ entered: [{ field: "name", label: "Введите имя", value: "Иван" }], failedActions: { "CLICK:e7": 2 } });
    expect(await repo.get(run.id, { familyId, userId: otherUserId })).toBeNull();
    expect(await repo.get(run.id, { familyId, userId })).toMatchObject({ activeMillis: 12_345, allowedFields: ["name", "phone"] });

    // Only one confirm leaves awaiting_confirmation; the claimed run stays active and busy.
    expect(await repo.transition(run.id, "awaiting_confirmation", "confirming")).toBe(true);
    expect(await repo.transition(run.id, "awaiting_confirmation", "confirming")).toBe(false);
    expect(await repo.activeForSandbox(sandbox)).toMatchObject({ id: run.id, status: "confirming" });

    run.status = "done";
    await repo.save(run);
    expect(await repo.activeForSandbox(sandbox)).toBeNull();
    expect(await repo.allowField(run.id, "email")).toBe(false);
    expect((await repo.get(run.id, { familyId, userId }))!.entered).toEqual([{ field: "name", label: "Введите имя" }]);
  });

  it("keeps one form profile per person and adds concurrent fields without losing either", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, otherUserId, userId } = await fixture(suffix);
    const profiles = createFormProfileRepository();
    const owner = { familyId, groupId: null, userId };

    expect(await profiles.get(owner)).toBeNull();
    await Promise.all([
      profiles.upsertField(owner, { domains: ["yclients.com"], field: "phone", value: "+79160000000" }),
      profiles.upsertField(owner, { domains: ["*"], field: "name", value: "Илья" }),
    ]);
    expect((await profiles.get(owner))!.fields).toMatchObject({ name: { value: "Илья" }, phone: { domains: ["yclients.com"], value: "+79160000000" } });

    await expect(profiles.upsertField(owner, { domains: ["*"], field: "cvc", value: "123" })).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_PROFILE_INVALID" });
    expect(await profiles.get({ familyId, groupId: null, userId: otherUserId })).toBeNull();

    // A membership removed after the session started closes the profile for reads and writes.
    await database().query("DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2", [familyId, userId]);
    await expect(profiles.get(owner)).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
    await expect(profiles.upsertField(owner, { domains: ["*"], field: "email", value: "a@b.ru" })).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
  });

  it("folds the old profile file in once, after a first field was saved where the file was unreadable", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, userId } = await fixture(suffix);
    const profiles = createFormProfileRepository();
    const owner = { familyId, groupId: null, userId };

    // Saved from the family group: the old file could not be looked at.
    await profiles.upsertField(owner, { domains: ["dikidi.net"], field: "phone", value: "+7222" }, null);
    expect(await profiles.get(owner)).toMatchObject({ legacyImported: false });

    const legacy = { email: { domains: ["*"], value: "old@b.ru" }, phone: { domains: ["*"], value: "+7111" } };
    const merged = await profiles.importLegacy(owner, legacy);
    expect(merged).toEqual({ email: { domains: ["*"], value: "old@b.ru" }, phone: { domains: ["dikidi.net"], value: "+7222" } });
    expect(await profiles.get(owner)).toMatchObject({ legacyImported: true });

    // Once folded, the file is never read into the row again.
    await profiles.importLegacy(owner, { email: { domains: ["*"], value: "other@b.ru" } });
    expect((await profiles.get(owner))!.fields.email!.value).toBe("old@b.ru");
  });

  it("opens the profile from a group only while it is registered as the family's private group", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, userId } = await fixture(suffix);
    const profiles = createFormProfileRepository();
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, $2, 'Семья', 'family_private', 'all') RETURNING id`,
      [familyId, `-100-profile-${suffix}`],
    );
    const fromGroup = { familyId, groupId: group.rows[0]!.id, userId };
    await profiles.upsertField(fromGroup, { domains: ["*"], field: "name", value: "Илья" });
    expect((await profiles.get(fromGroup))!.fields.name!.value).toBe("Илья");

    await database().query("UPDATE telegram_groups SET type = 'external' WHERE id = $1", [fromGroup.groupId]);
    await expect(profiles.get(fromGroup)).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
    await expect(profiles.upsertField(fromGroup, { domains: ["*"], field: "phone", value: "+7" })).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
    // The private chat of the same person is unaffected.
    expect((await profiles.get({ familyId, groupId: null, userId }))!.fields.name!.value).toBe("Илья");
  });

  it("starts a new profile when the person moved to another family", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, userId } = await fixture(suffix);
    const profiles = createFormProfileRepository();
    await profiles.upsertField({ familyId, groupId: null, userId }, { domains: ["*"], field: "name", value: "Старое" });

    const other = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Other ${suffix}`]);
    // A move ends the old membership and its private conversation, keeping the same users.id.
    await database().query("DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2", [familyId, userId]);
    await database().query("DELETE FROM application_conversations WHERE family_id = $1 AND owner_user_id = $2", [familyId, userId]);
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')", [other.rows[0]!.id, userId]);
    const moved = { familyId: other.rows[0]!.id, groupId: null, userId };

    expect(await profiles.get(moved)).toBeNull();
    await profiles.upsertField(moved, { domains: ["*"], field: "phone", value: "+7333" });
    expect((await profiles.get(moved))!.fields).toEqual({ phone: { domains: ["*"], value: "+7333" } });
  });
});
