/** Live external registration owns the sandbox access class, never restored runtime metadata. */
import type { PoolClient } from "pg";
import { database } from "../database.js";
import { AppError } from "../app-error.js";
import { parseExternalGroupToolAllowlist } from "../tool-policy/group-tool-catalog.js";
import type { SandboxAccess } from "./sandbox-runner-contract.js";

export async function withGroupSandboxAccess<T>(
  workspaceId: string, operation: (access: SandboxAccess) => Promise<T>, requiredCapability?: "bash",
): Promise<T> {
  const client: PoolClient = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ tool_allowlist: string[] }>(
      `SELECT g.tool_allowlist FROM workspaces w JOIN telegram_groups g ON g.id=w.group_id
       WHERE w.id=$1 AND w.scope='group' AND g.type='external' AND w.family_id=g.family_id
       FOR SHARE OF g`, [workspaceId],
    );
    const allowed = result.rows[0] && parseExternalGroupToolAllowlist(result.rows[0].tool_allowlist);
    if (!allowed) throw new AppError("AGENT_GROUP_REGISTRATION_INVALID", "Рабочая папка больше не принадлежит действующей внешней группе");
    if (requiredCapability && !allowed.has(requiredCapability)) {
      throw new AppError("AGENT_GROUP_TOOL_FORBIDDEN", "Bash больше не разрешён в этой группе. Обратитесь к владельцу агента");
    }
    const value = await operation(allowed.has("bash") ? "group-tools" : "restricted");
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
