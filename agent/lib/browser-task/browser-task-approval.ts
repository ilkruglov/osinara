/**
 * What the confirmation window of browser_task shows, read from the run the click is bound to.
 *
 * Exports:
 * - `BrowserTaskApprovalSubject`: site, button, page and the data that goes with the click.
 * - `describeBrowserTaskApproval`: builds the subject from a run, pure.
 * - `loadBrowserTaskApproval`: production loader behind the Telegram approval presenter.
 *
 * Key construct:
 * - The model's retelling of the summary is not the confirmation. The window is built by the
 *   application from the same pending action `confirm` will click and from the values the loop
 *   actually typed, not from the profile as it is now: a later save_field, from any chat, cannot
 *   make the window show one phone while the form sends another.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { type BrowserTaskRun, browserTaskRunRepository } from "./browser-task-run-repository.js";

export interface BrowserTaskApprovalSubject {
  button: string;
  fields: Array<{ label: string; value: string }>;
  site: string;
  url: string;
}

export function describeBrowserTaskApproval(run: BrowserTaskRun): BrowserTaskApprovalSubject {
  const pending = run.pendingAction;
  if (run.status !== "awaiting_confirmation" || !pending) {
    throw new AppError("AGENT_APPROVAL_SUBJECT_NOT_FOUND", "Задача в браузере больше не ждёт подтверждения");
  }
  const site = new URL(pending.url).hostname;
  const fields = run.entered.map(({ label, value }) => ({ label, value: value ?? "значение не сохранено" }));
  return { button: pending.label, fields, site, url: pending.url };
}

export async function loadBrowserTaskApproval(
  runId: string,
  ctx: Pick<SessionContext, "session">,
): Promise<BrowserTaskApprovalSubject> {
  const auth = requireWorkspaceAuthorization(ctx);
  if (auth.userId === null) throw new AppError("AGENT_APPROVAL_SUBJECT_NOT_FOUND", "Задача в браузере не найдена");
  const owner = { familyId: auth.familyId, userId: auth.userId };
  const run = await browserTaskRunRepository.get(runId, owner);
  if (!run) throw new AppError("AGENT_APPROVAL_SUBJECT_NOT_FOUND", "Задача в браузере не найдена");
  return describeBrowserTaskApproval(run);
}
