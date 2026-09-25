/**
 * Durable form profile of one person for browser_task.
 *
 * Exports:
 * - `createFormProfileRepository`: read a person's profile, add or replace one field.
 * - `formProfileRepository`: production repository.
 * - `loadFormProfile`: the profile a run uses, with the v1.2.1 workspace file as a first-time seed.
 * - `saveFormProfileField`: production save_field, seeded the same way.
 *
 * Key constructs:
 * - The profile belongs to the person, not to a workspace: the private chat and the family group
 *   read the same row, so a phone given in the group is there for a booking from the private chat.
 *   Nobody else reads it; a family group never gains the personal workspace for this.
 * - One field changes under a row lock, so two quick save_field calls do not lose each other.
 * - Every stored profile passes `parseFormProfile` on the way out, so a card or password field
 *   cannot come back even if a row was edited by hand.
 */
import { isAppError } from "../app-error.js";
import { database } from "../database.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { type FormProfile, parseFormProfile, type ProfileField, upsertProfileField } from "./form-profile.js";

/** Where v1.2.1 kept the profile; read to seed the database row, never written again. */
const LEGACY_PROFILE_PATH = "forms/profile.json";

export interface FormProfileOwner { familyId: string; userId: string; }

export function createFormProfileRepository() {
  return {
    async get(owner: FormProfileOwner): Promise<FormProfile | null> {
      const result = await database().query<{ fields: FormProfile }>(
        "SELECT fields FROM browser_form_profiles WHERE user_id = $1 AND family_id = $2",
        [owner.userId, owner.familyId],
      );
      const row = result.rows[0];
      return row ? parseFormProfile(JSON.stringify(row.fields)) : null;
    },

    /** Returns the stored entry of the field after the change. */
    async upsertField(
      owner: FormProfileOwner,
      input: { domains: readonly string[]; field: string; value: string },
      seed: () => Promise<FormProfile> = async () => ({}),
    ): Promise<ProfileField> {
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO browser_form_profiles (user_id, family_id) VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING`,
          [owner.userId, owner.familyId],
        );
        const current = await client.query<{ fields: FormProfile }>(
          "SELECT fields FROM browser_form_profiles WHERE user_id = $1 AND family_id = $2 FOR UPDATE",
          [owner.userId, owner.familyId],
        );
        if (!current.rows[0]) throw new Error("AGENT_BROWSER_TASK_PROFILE_OWNER_MISMATCH");
        const stored = parseFormProfile(JSON.stringify(current.rows[0].fields));
        const base = Object.keys(stored).length > 0 ? stored : await seed();
        const next = upsertProfileField(base, input);
        await client.query(
          "UPDATE browser_form_profiles SET fields = $2, updated_at = now() WHERE user_id = $1",
          [owner.userId, JSON.stringify(next)],
        );
        await client.query("COMMIT");
        return next[input.field.trim()]!;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const formProfileRepository = createFormProfileRepository();

/** Only the private chat can still read the personal workspace; elsewhere the seed is empty. */
async function readLegacyProfile(auth: WorkspaceAuthorization): Promise<FormProfile> {
  try {
    const file = await workspaceBinaryRepository.readBinary(auth, "personal", LEGACY_PROFILE_PATH);
    return parseFormProfile(Buffer.from(file.bytes).toString("utf8"));
  } catch (error) {
    const ignorable = ["AGENT_BROWSER_TASK_PROFILE_INVALID", "AGENT_WORKSPACE_ACCESS_DENIED", "AGENT_WORKSPACE_FILE_NOT_FOUND"];
    if (isAppError(error) && ignorable.includes(error.code)) return {};
    throw error;
  }
}

export async function loadFormProfile(auth: WorkspaceAuthorization, owner: FormProfileOwner): Promise<FormProfile> {
  return await formProfileRepository.get(owner) ?? await readLegacyProfile(auth);
}

export async function saveFormProfileField(
  auth: WorkspaceAuthorization,
  owner: FormProfileOwner,
  input: { domains: readonly string[]; field: string; value: string },
): Promise<ProfileField> {
  return await formProfileRepository.upsertField(owner, input, () => readLegacyProfile(auth));
}
