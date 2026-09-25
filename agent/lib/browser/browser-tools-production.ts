/**
 * The production browser tools: one factory instance shared by the six tool modules.
 *
 * Exports:
 * - `browserTools`: `createBrowserTools` bound to the sandbox runner, the look repository, the
 *   vision inspector and the form profile of the requester.
 * - `loadBrowserConfirmApproval`: what the confirmation window shows for `browser_confirm`.
 */
import type { SessionContext } from "eve/context";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { AppError } from "../app-error.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { sandboxSessionId } from "../sessions/session-context.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { inspectWorkspaceImage } from "../workspaces/workspace-image-inspection.js";
import { createSandboxBrowserDriver } from "./browser-driver.js";
import { createBrowserTools } from "./browser-tools.js";
import { loadFormProfile, saveFormProfileField } from "./form-profile-repository.js";
import { lookRepository } from "./look-repository.js";

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export const browserTools = createBrowserTools({
  approvalEvidence: (ctx, input) => requireToolApprovalEvidence(ctx, "browser_confirm", input),
  driver: (ctx, sandbox) => createSandboxBrowserDriver({ runner, sandboxSessionId: sandbox, signal: ctx.abortSignal }),
  loadProfile: loadFormProfile,
  log: (event) => console.info(JSON.stringify(event)),
  looks: lookRepository,
  now: () => Date.now(),
  sandboxSessionId: (ctx) => sandboxSessionId(ctx),
  saveProfileField: saveFormProfileField,
  async vision(auth, scope, path, question) {
    const result = await inspectWorkspaceImage(auth, { path, question, scope });
    return "supported" in result && result.supported === false ? null : result.analysis;
  },
});

export interface BrowserConfirmApprovalSubject { button: string; entered: string[]; site: string; url: string; }

/** The parked click of this conversation's browser, or nothing: the window never guesses. */
export async function loadBrowserConfirmApproval(
  input: { epoch: string; n: number },
  ctx: Pick<SessionContext, "session">,
): Promise<BrowserConfirmApprovalSubject> {
  const auth = requireWorkspaceAuthorization(ctx);
  const look = await lookRepository.get(sandboxSessionId(ctx), auth.familyId);
  const pending = look?.pending;
  if (!look || !pending || pending.epoch !== input.epoch || pending.n !== input.n || look.epoch !== input.epoch) {
    throw new AppError("AGENT_APPROVAL_SUBJECT_NOT_FOUND", "В браузере нет шага, ждущего подтверждения");
  }
  return { button: pending.element.text, entered: look.entered.map((e) => e.label), site: new URL(look.url).hostname, url: look.url };
}
