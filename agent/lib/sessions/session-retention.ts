/**
 * Eve 0.32.0 session retention job boundary.
 *
 * Export:
 * - `deleteExpiredSessions`: leases and physically deletes retired Eve sessions.
 */
import { resolve } from "node:path";

import { isAppError } from "../app-error.js";
import { deleteLocalEveSession } from "./eve-session-storage.js";
import { sessionRepository } from "./session-repository.js";

const WORKFLOW_DATA_ROOT = resolve(".eve", ".workflow-data");

export async function deleteExpiredSessions(): Promise<number> {
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
