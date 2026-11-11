/**
 * Shared fixtures of the health journal's PostgreSQL tests.
 *
 * Exports:
 * - `createHealthFamily`: an owner and a member of a new family, the owner with a timezone.
 * - `nextOperationKey`: a fresh Eve-like call id.
 * - `failureOf`: the code and message a journal call failed with, or "no error".
 * - `noWorkspace`: a workspace resolver for summaries that must not write a card.
 */
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { createMemoryFamilyFixture } from "../memory-repository.integration-fixtures.js";

let counter = 0;

export const nextOperationKey = () => `health-${Date.now()}-${(counter += 1)}`;

export async function createHealthFamily(timezone: string | null = "Europe/Moscow"): Promise<{
  familyId: string;
  member: MemoryAuthorization;
  owner: MemoryAuthorization;
}> {
  const fixture = await createMemoryFamilyFixture(`health-${Date.now()}-${(counter += 1)}`);
  if (timezone !== null)
    await database().query(
      "INSERT INTO user_notification_settings (user_id, timezone) VALUES ($1, $2)",
      [fixture.owner.userId, timezone],
    );
  return {
    familyId: fixture.familyId,
    member: fixture.member as MemoryAuthorization,
    owner: fixture.owner as MemoryAuthorization,
  };
}

export async function failureOf(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return {
      code: (error as { code?: string }).code ?? String(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { code: "no error", message: "" };
}

export const noWorkspace = () => {
  throw new Error("the card is not written in this test");
};
