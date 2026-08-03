/**
 * Current external-group capability policy.
 *
 * Export:
 * - `loadCurrentExternalGroupCapabilities`: reads and validates the current PostgreSQL allowlist.
 */
import { database } from "../database.js";
import {
  parseExternalGroupToolAllowlist,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

export async function loadCurrentExternalGroupCapabilities(input: {
  familyId: string;
  groupId: string;
}): Promise<ReadonlySet<ExternalGroupToolName>> {
  const result = await database().query<{ tool_allowlist: string[] }>(
    `SELECT tool_allowlist
       FROM telegram_groups
      WHERE id = $1
        AND family_id = $2
        AND type = 'external'`,
    [input.groupId, input.familyId],
  );
  const allowed = parseExternalGroupToolAllowlist(result.rows[0]?.tool_allowlist);

  // Missing, replaced, or malformed persisted policy always becomes deny-all.
  return allowed ?? new Set();
}
