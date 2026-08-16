/**
 * Eve 0.32.0 session retention job boundary.
 *
 * Export:
 * - `deleteExpiredSessions`: globally serializes, leases, and physically deletes retired Eve sessions.
 */
import { resolve } from "node:path";

import { isAppError } from "../app-error.js";
import { database } from "../database.js";
import { deleteLocalEveSession } from "./eve-session-storage.js";
import { sessionRepository } from "./session-repository.js";

const SESSION_RETENTION_ADVISORY_LOCK_KEY = "osinara-eve-session-retention";
const WORKFLOW_DATA_ROOT = resolve(".eve", ".workflow-data");

export async function deleteExpiredSessions(): Promise<number> {
  // Per-session leases allow parallel workers, but world-local hook indexes are shared across runs.
  // Hold one dedicated connection for the complete physical sweep and destroy it to release the lock
  // even when filesystem cleanup throws before PostgreSQL can be contacted again.
  const lockClient = await database().connect();
  let acquired = false;
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [SESSION_RETENTION_ADVISORY_LOCK_KEY],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) return 0;

    return await deleteExpiredSessionsUnderLock();
  } finally {
    lockClient.release(acquired);
  }
}

async function deleteExpiredSessionsUnderLock(): Promise<number> {
  // The existing minute lifecycle hook bounds abandoned task rows before physical Eve deletion.
  await sessionRepository.retireAbandonedTasks(new Date());
  let deleted = 0;
  while (true) {
    const claim = await sessionRepository.claimExpiredForDeletion(new Date());
    if (!claim) return deleted;

    try {
      await deleteLocalEveSession(WORKFLOW_DATA_ROOT, claim.eveSessionId);
      await sessionRepository.completeDeletion(claim.id, claim.leaseToken);
      deleted += 1;
    } catch (error) {
      // This schedule is the boundary: persist context and rethrow so the failure is observable.
      const errorCode = isAppError(error) ? error.code : "AGENT_SESSION_RETENTION_DELETE_FAILED";
      await sessionRepository.failDeletion(claim.id, claim.leaseToken, errorCode);
      console.error("Session retention deletion failed", {
        applicationSessionId: claim.id,
        error,
        errorCode,
        eveSessionId: claim.eveSessionId,
      });
      throw error;
    }
  }
}
