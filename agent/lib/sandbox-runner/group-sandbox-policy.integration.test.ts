/** Restored sandbox metadata cannot override a revoked group grant or a private workspace boundary. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { database, closeDatabase } from "../database.js";
import { withGroupSandboxAccess } from "./group-sandbox-policy.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const integration = enabled ? describe : describe.skip;
integration("live group sandbox policy", () => {
  beforeEach(async () => { await database().query("TRUNCATE users,families CASCADE"); });
  afterAll(closeDatabase);
  it("changes access on the next operation and rejects removal of the registration", async () => {
    const family = (await database().query<{ id: string }>("INSERT INTO families(name) VALUES('Sandbox policy') RETURNING id")).rows[0]!;
    const group = (await database().query<{ id: string }>(
      "INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-900055','Sandbox','external','all') RETURNING id", [family.id],
    )).rows[0]!;
    const workspace = (await database().query<{ id: string }>(
      "INSERT INTO workspaces(family_id,group_id,scope) VALUES($1,$2,'group') RETURNING id", [family.id,group.id],
    )).rows[0]!;
    expect(await withGroupSandboxAccess(workspace.id, async (access) => access)).toBe("restricted");
    await database().query("UPDATE telegram_groups SET tool_allowlist=ARRAY['bash'] WHERE id=$1", [group.id]);
    expect(await withGroupSandboxAccess(workspace.id, async (access) => access)).toBe("group-tools");
    let release!: () => void;
    let selected!: () => void;
    const selection = new Promise<void>((resolve) => { selected = resolve; });
    const continueSelection = new Promise<void>((resolve) => { release = resolve; });
    const held = withGroupSandboxAccess(workspace.id, async (access) => {
      selected();
      await continueSelection;
      return access;
    }, "bash");
    await selection;
    const revoker = await database().connect();
    try {
      await revoker.query("SET lock_timeout='100ms'");
      await expect(revoker.query("UPDATE telegram_groups SET tool_allowlist='{}' WHERE id=$1", [group.id]))
        .rejects.toMatchObject({ code: "55P03" });
    } finally {
      await revoker.query("RESET lock_timeout");
      revoker.release();
      release();
      expect(await held).toBe("group-tools");
    }
    await database().query("UPDATE telegram_groups SET tool_allowlist='{}' WHERE id=$1", [group.id]);
    const execute = vi.fn();
    await expect(withGroupSandboxAccess(workspace.id, execute, "bash")).rejects.toThrow("AGENT_GROUP_TOOL_FORBIDDEN");
    expect(execute).not.toHaveBeenCalled();
    expect(await withGroupSandboxAccess(workspace.id, async (access) => access)).toBe("restricted");
    await database().query("UPDATE telegram_groups SET type='family_private' WHERE id=$1", [group.id]);
    await expect(withGroupSandboxAccess(workspace.id, async (access) => access)).rejects.toThrow("AGENT_GROUP_REGISTRATION_INVALID");
  });
});
