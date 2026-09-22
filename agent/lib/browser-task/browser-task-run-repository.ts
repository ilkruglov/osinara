/**
 * Durable state of one browser_task run.
 *
 * Exports:
 * - `BrowserTaskRun`, `BrowserTaskStatus`, `StepRecord`, `PendingAction`: the run as the loop sees it.
 * - `createBrowserTaskRunRepository`: create, read by owner, save, find the active run of a sandbox.
 * - `browserTaskRunRepository`: production repository.
 *
 * Key construct:
 * - `confirm` and `resume` arrive as separate tool calls, minutes apart and possibly after a
 *   restart, so everything the loop needs to continue lives here. Entered values do not: the
 *   row keeps which fields were filled, never what was typed.
 */
import { database } from "../database.js";

export type BrowserTaskStatus =
  | "awaiting_confirmation" | "blocked" | "cancelled" | "done" | "failed" | "needs_plan" | "running" | "unverified";
/** `key` is `${operation}:${ref or name}`; it counts failures and repeats, `action` is what Jev reads. */
export interface StepRecord { action: string; confidence: number; key?: string; url: string; }
export interface PendingAction { label: string; ref: string | null; summary: string; url: string; }
export interface BrowserTaskRun {
  id: string;
  familyId: string;
  userId: string;
  scope: "family" | "personal";
  sandboxSessionId: string;
  goal: string;
  startUrl: string | null;
  allowedFields: string[];
  extraData: Record<string, string>;
  hint: string | null;
  status: BrowserTaskStatus;
  stepCount: number;
  handoffCount: number;
  history: StepRecord[];
  entered: Array<{ field: string; label: string }>;
  pendingAction: PendingAction | null;
  failedActions: Record<string, number>;
  lastSignature: string | null;
  lastUrl: string | null;
  startedAt: Date;
}
export type NewBrowserTaskRun = Pick<
  BrowserTaskRun,
  "allowedFields" | "extraData" | "familyId" | "goal" | "sandboxSessionId" | "scope" | "startUrl" | "userId"
>;

interface Row {
  id: string; family_id: string; user_id: string; scope: "family" | "personal"; sandbox_session_id: string;
  goal: string; start_url: string | null; allowed_fields: string[]; extra_data: Record<string, string>;
  hint: string | null; status: BrowserTaskStatus; step_count: number; handoff_count: number;
  history: StepRecord[]; entered: Array<{ field: string; label: string }>; pending_action: PendingAction | null;
  failed_actions: Record<string, number>; last_signature: string | null; last_url: string | null; started_at: Date;
}
const COLUMNS = `id, family_id, user_id, scope, sandbox_session_id, goal, start_url, allowed_fields, extra_data, hint,
  status, step_count, handoff_count, history, entered, pending_action, failed_actions, last_signature, last_url, started_at`;
const ACTIVE = "('running', 'awaiting_confirmation', 'needs_plan')";

function fromRow(row: Row): BrowserTaskRun {
  return {
    allowedFields: row.allowed_fields, entered: row.entered, extraData: row.extra_data, failedActions: row.failed_actions,
    familyId: row.family_id, goal: row.goal, handoffCount: row.handoff_count, hint: row.hint, history: row.history,
    id: row.id, lastSignature: row.last_signature, lastUrl: row.last_url, pendingAction: row.pending_action,
    sandboxSessionId: row.sandbox_session_id, scope: row.scope, startUrl: row.start_url, startedAt: row.started_at,
    status: row.status, stepCount: row.step_count, userId: row.user_id,
  };
}

export function createBrowserTaskRunRepository() {
  return {
    async create(input: NewBrowserTaskRun): Promise<BrowserTaskRun> {
      const result = await database().query<Row>(
        `INSERT INTO browser_task_runs
           (family_id, user_id, scope, sandbox_session_id, goal, start_url, allowed_fields, extra_data, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')
         RETURNING ${COLUMNS}`,
        [input.familyId, input.userId, input.scope, input.sandboxSessionId, input.goal, input.startUrl,
          input.allowedFields, JSON.stringify(input.extraData)],
      );
      return fromRow(result.rows[0]!);
    },

    async get(id: string, owner: { familyId: string; userId: string }): Promise<BrowserTaskRun | null> {
      const result = await database().query<Row>(
        `SELECT ${COLUMNS} FROM browser_task_runs WHERE id = $1 AND family_id = $2 AND user_id = $3`,
        [id, owner.familyId, owner.userId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },

    async save(run: BrowserTaskRun): Promise<void> {
      await database().query(
        `UPDATE browser_task_runs
            SET hint = $2, status = $3, step_count = $4, handoff_count = $5, history = $6, entered = $7,
                pending_action = $8, failed_actions = $9, last_signature = $10, last_url = $11, updated_at = now()
          WHERE id = $1`,
        [run.id, run.hint, run.status, run.stepCount, run.handoffCount, JSON.stringify(run.history),
          JSON.stringify(run.entered), run.pendingAction === null ? null : JSON.stringify(run.pendingAction),
          JSON.stringify(run.failedActions), run.lastSignature, run.lastUrl],
      );
    },

    async activeForSandbox(sandboxSessionId: string): Promise<BrowserTaskRun | null> {
      const result = await database().query<Row>(
        `SELECT ${COLUMNS} FROM browser_task_runs
          WHERE sandbox_session_id = $1 AND status IN ${ACTIVE}
          ORDER BY started_at DESC LIMIT 1`,
        [sandboxSessionId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
  };
}

export const browserTaskRunRepository = createBrowserTaskRunRepository();
