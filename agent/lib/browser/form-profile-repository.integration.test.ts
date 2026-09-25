/**
 * Form profile repository integration tests.
 *
 * Constructs covered:
 * - One profile per person and family: fields add up under concurrent writes, a card field is
 *   refused, another member reads nothing, a removed member reads and writes nothing.
 * - From a group the profile opens only while that group is still the family's private group.
 * - The old profile file is folded in once, after a first field was saved where it was unreadable.
 */
import { afterAll, describe, expect, it } from "vitest";

import { database } from "../database.js";
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
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Profile family ${suffix}`]);
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Owner'), ($2, 'Member') RETURNING id, telegram_user_id`,
    [`profile-owner-${suffix}`, `profile-member-${suffix}`],
  );
  const owner = users.rows.find((row) => row.telegram_user_id === `profile-owner-${suffix}`)!;
  const member = users.rows.find((row) => row.telegram_user_id === `profile-member-${suffix}`)!;
  await database().query(`INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [family.rows[0]!.id, owner.id, member.id]);
  return { familyId: family.rows[0]!.id, otherUserId: member.id, userId: owner.id };
}

describeWithDatabase("formProfileRepository", () => {
  afterAll(async () => { await database().end(); });

  it("keeps one profile per person, adds concurrent fields, refuses card fields and removed members", async () => {
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

    await database().query("DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2", [familyId, userId]);
    await expect(profiles.get(owner)).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
    await expect(profiles.requireAccess(owner)).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
    await expect(profiles.upsertField(owner, { domains: ["*"], field: "email", value: "a@b.ru" })).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
  });

  it("opens the profile from a group only while it is registered as the family's private group", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, userId } = await fixture(suffix);
    const profiles = createFormProfileRepository();
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode) VALUES ($1, $2, 'Семья', 'family_private', 'all') RETURNING id`,
      [familyId, `-100-profile-${suffix}`],
    );
    const fromGroup = { familyId, groupId: group.rows[0]!.id, userId };
    await profiles.upsertField(fromGroup, { domains: ["*"], field: "name", value: "Илья" });
    expect((await profiles.get(fromGroup))!.fields.name!.value).toBe("Илья");

    await database().query("UPDATE telegram_groups SET type = 'external' WHERE id = $1", [fromGroup.groupId]);
    await expect(profiles.get(fromGroup)).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
    expect((await profiles.get({ familyId, groupId: null, userId }))!.fields.name!.value).toBe("Илья");
  });

  it("folds the old profile file in once, without overwriting newer fields", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { familyId, userId } = await fixture(suffix);
    const profiles = createFormProfileRepository();
    const owner = { familyId, groupId: null, userId };

    await profiles.upsertField(owner, { domains: ["dikidi.net"], field: "phone", value: "+7222" }, null);
    expect(await profiles.get(owner)).toMatchObject({ legacyImported: false });
    const merged = await profiles.importLegacy(owner, { email: { domains: ["*"], value: "old@b.ru" }, phone: { domains: ["*"], value: "+7111" } });
    expect(merged).toEqual({ email: { domains: ["*"], value: "old@b.ru" }, phone: { domains: ["dikidi.net"], value: "+7222" } });
    await profiles.importLegacy(owner, { email: { domains: ["*"], value: "other@b.ru" } });
    expect((await profiles.get(owner))!.fields.email!.value).toBe("old@b.ru");
  });
});
