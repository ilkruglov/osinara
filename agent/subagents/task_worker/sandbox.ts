/**
 * Isolated universal task worker sandbox.
 *
 * Export:
 * - A separate networkless runner session over the caller's authorized workspace mounts.
 */
import { defineSandbox } from "eve/sandbox";

import { taskWorkerRunner } from "../../lib/sandbox-runner/runner-sandbox-backend.js";
import { requireWorkspaceAuthorization } from "../../lib/workspaces/workspace-context.js";
import { workspaceRepository } from "../../lib/workspaces/workspace-repository.js";

export default defineSandbox({
  backend: taskWorkerRunner(),
  async onSession({ ctx, use }) {
    const mounts = await workspaceRepository.mounts(requireWorkspaceAuthorization(ctx));
    // Eve's child session ID keeps compute separate while shared volume subpaths expose artifacts.
    await use({ mounts, sandboxSessionId: ctx.session.id });
  },
});
