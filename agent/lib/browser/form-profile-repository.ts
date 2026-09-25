/**
 * Durable form profile of one person for browser_task.
 *
 * Exports:
 * - `createFormProfileRepository`: read a person's profile, add or replace one field, fold in the
 *   v1.2.1 profile file.
 * - `formProfileRepository`: production repository.
 * - `loadFormProfile`: the profile a run uses, folding the v1.2.1 workspace file in on first sight.
 * - `saveFormProfileField`: production save_field, folding the same file in first.
 *
 * Key constructs:
 * - The profile belongs to the person, not to a workspace: the private chat and the family group
 *   read the same row, so a phone given in the group is there for a booking from the private chat.
 *   Nobody else reads it; a family group never gains the personal workspace for this.
 * - Access follows current state, read inside the same statement, like the workspace it replaces:
 *   the person must still be a member of the family, and a call from a group needs that group to
 *   still be this family's private group. A session that outlived a removed membership, or a turn
 *   still running in a group the owner just turned external, reads and writes nothing.
 * - The row is keyed by person and family: someone who moved to another family starts afresh
 *   there instead of being locked out by the old family's row.
 * - One field changes under a row lock, so two quick save_field calls do not lose each other.
 * - v1.2.1 kept the profile in `personal/forms/profile.json`, readable from the private chat only.
 *   `legacy_imported` stays false until that file was actually looked at, so a first field saved
 *   from the family group does not hide the old file forever; the fold never overwrites a field
 *   the row already has.
 * - Every stored profile passes `parseFormProfile` on the way out, so a card or password field
 *   cannot come back even if a row was edited by hand.
 */
import type { PoolClient } from "pg";

import { AppError, isAppError } from "../app-error.js";
import { database } from "../database.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { type FormProfile, parseFormProfile, type ProfileField, upsertProfileField } from "./form-profile.js";

const LEGACY_PROFILE_PATH = "forms/profile.json";

/** `groupId` is the Telegram group the call comes from, `null` in the private chat. */
export interface FormProfileOwner { familyId: string; groupId: string | null; userId: string; }

/** $1 user, $2 family, $3 group or null: evaluated in the statement that reads or writes. */
const ACCESS = `EXISTS (SELECT 1 FROM family_memberships m WHERE m.family_id = $2 AND m.user_id = $1)
  AND ($3::uuid IS NULL OR EXISTS (
    SELECT 1 FROM telegram_groups g WHERE g.id = $3::uuid AND g.family_id = $2 AND g.type = 'family_private'))`;
const accessParams = (owner: FormProfileOwner) => [owner.userId, owner.familyId, owner.groupId];
/** `null`: the old file could not be looked at from here. `{}`: there is none, or it is unusable. */
export type LegacyProfile = FormProfile | null;

function revoked(): AppError {
  return new AppError("AGENT_WORKSPACE_ACCESS_REVOKED", "Доступ к анкете был отозван");
}

/** Locks and returns the owner's row, creating it; throws when the membership is gone. */
async function lockRow(client: PoolClient, owner: FormProfileOwner): Promise<{ fields: FormProfile; legacyImported: boolean }> {
  await client.query(
    `INSERT INTO browser_form_profiles (user_id, family_id)
     SELECT $1, $2 WHERE ${ACCESS}
     ON CONFLICT (user_id, family_id) DO NOTHING`,
    accessParams(owner),
  );
  const current = await client.query<{ fields: FormProfile; legacy_imported: boolean }>(
    `SELECT p.fields, p.legacy_imported FROM browser_form_profiles p
      WHERE p.user_id = $1 AND p.family_id = $2 AND ${ACCESS}
      FOR UPDATE OF p`,
    accessParams(owner),
  );
  const row = current.rows[0];
  if (!row) throw revoked();
  return { fields: parseFormProfile(JSON.stringify(row.fields)), legacyImported: row.legacy_imported };
}

/** Old fields fill only the gaps: whatever the row already has is newer. */
function fold(stored: FormProfile, legacy: FormProfile): FormProfile {
  return { ...legacy, ...stored };
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createFormProfileRepository() {
  return {
    /** `null` when the person has no row yet; throws when the membership is gone. */
    async get(owner: FormProfileOwner): Promise<{ fields: FormProfile; legacyImported: boolean } | null> {
      const result = await database().query<{ allowed: boolean; fields: FormProfile | null; legacy_imported: boolean | null }>(
        `SELECT ${ACCESS} AS allowed, p.fields, p.legacy_imported
           FROM (SELECT 1) AS one
           LEFT JOIN browser_form_profiles p ON p.user_id = $1 AND p.family_id = $2`,
        accessParams(owner),
      );
      const row = result.rows[0]!;
      if (!row.allowed) throw revoked();
      if (row.fields === null) return null;
      return { fields: parseFormProfile(JSON.stringify(row.fields)), legacyImported: row.legacy_imported === true };
    },

    /** Folds the old file in once it could be read; a `null` legacy leaves the row waiting. */
    async importLegacy(owner: FormProfileOwner, legacy: LegacyProfile): Promise<FormProfile> {
      return await inTransaction(async (client) => {
        const row = await lockRow(client, owner);
        if (row.legacyImported || legacy === null) return row.fields;
        const fields = fold(row.fields, legacy);
        await client.query(
          "UPDATE browser_form_profiles SET fields = $3, legacy_imported = true, updated_at = now() WHERE user_id = $1 AND family_id = $2",
          [owner.userId, owner.familyId, JSON.stringify(fields)],
        );
        return fields;
      });
    },

    /** Returns the stored entry of the field after the change. */
    async upsertField(
      owner: FormProfileOwner,
      input: { domains: readonly string[]; field: string; value: string },
      legacy: LegacyProfile = null,
    ): Promise<ProfileField> {
      return await inTransaction(async (client) => {
        const row = await lockRow(client, owner);
        const importNow = !row.legacyImported && legacy !== null;
        const base = importNow ? fold(row.fields, legacy) : row.fields;
        const next = upsertProfileField(base, input);
        await client.query(
          "UPDATE browser_form_profiles SET fields = $3, legacy_imported = legacy_imported OR $4, updated_at = now() WHERE user_id = $1 AND family_id = $2",
          [owner.userId, owner.familyId, JSON.stringify(next), importNow],
        );
        return next[input.field.trim()]!;
      });
    },
  };
}

export const formProfileRepository = createFormProfileRepository();

/** Only the private chat can look at the personal workspace; elsewhere the answer is "unknown". */
async function readLegacyProfile(auth: WorkspaceAuthorization): Promise<LegacyProfile> {
  if (auth.telegramChatType !== "private") return null;
  try {
    const file = await workspaceBinaryRepository.readBinary(auth, "personal", LEGACY_PROFILE_PATH);
    return parseFormProfile(Buffer.from(file.bytes).toString("utf8"));
  } catch (error) {
    if (!isAppError(error)) throw error;
    if (error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND" || error.code === "AGENT_BROWSER_TASK_PROFILE_INVALID") return {};
    if (error.code === "AGENT_WORKSPACE_ACCESS_DENIED") return null;
    throw error;
  }
}

export async function loadFormProfile(auth: WorkspaceAuthorization, owner: FormProfileOwner): Promise<FormProfile> {
  const stored = await formProfileRepository.get(owner);
  if (stored?.legacyImported) return stored.fields;
  const legacy = await readLegacyProfile(auth);
  if (legacy === null) return stored?.fields ?? {};
  // Nothing to fold and no row yet: do not create an empty row just for having looked.
  if (stored === null && Object.keys(legacy).length === 0) return {};
  return await formProfileRepository.importLegacy(owner, legacy);
}

export async function saveFormProfileField(
  auth: WorkspaceAuthorization,
  owner: FormProfileOwner,
  input: { domains: readonly string[]; field: string; value: string },
): Promise<ProfileField> {
  const stored = await formProfileRepository.get(owner);
  const legacy = stored?.legacyImported ? null : await readLegacyProfile(auth);
  return await formProfileRepository.upsertField(owner, input, legacy);
}
