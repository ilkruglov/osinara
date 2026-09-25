/**
 * Durable state of one browser_task run.
 *
 * Exports:
 * - `BrowserTaskRun`, `BrowserTaskStatus`, `StepRecord`, `PendingAction`: the run as the loop sees it.
 * - `createBrowserTaskRunRepository`: create, read by owner, save, claim a status transition,
 *   allow one more field in an active run, find the active run of a sandbox.
 * - `browserTaskRunRepository`: production repository.
 *
 * Key constructs:
 * - `confirm` and `resume` arrive as separate tool calls, minutes apart and possibly after a
 *   restart, so everything the loop needs to continue lives here. That includes what was typed
 *   into each field while the run is active: the confirmation window shows exactly that, not the
 *   profile as it is now. A finished run keeps only which fields were filled.
 * - `allowed_fields` has one writer, `allowField`, a single conditional UPDATE: a whole-row save
 *   from a stale copy would otherwise undo a confirm that finished in between.
 * - `confirming` is written, conditionally, before the irreversible click. A crash or a repeated
 *   confirm then finds that state instead of `awaiting_confirmation` and cannot click twice.
 * - `activeMillis` is loop time only: waiting for a person does not count against the budget.
 */
import { database } from "../database.js";

export type BrowserTaskStatus =
  | "awaiting_confirmation" | "blocked" | "cancelled" | "confirming" | "done" | "failed" | "needs_plan" | "running"
  | "unverified";
/** `key` is `${operation}:${ref or name}`; it counts failures and repeats, `action` is what Jev reads. */
export interface StepRecord { action: string; confidence: number; key?: string; url: string; }
/** The confirmed click is bound to this element on a page with this exact content. */
export interface PendingAction { label: string; pageHash: string; ref: string | null; role: string; url: string; }
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
  entered: EnteredField[];
  pendingAction: PendingAction | null;
  failedActions: Record<string, number>;
  lastSignature: string | null;
  lastUrl: string | null;
  activeMillis: number;
  startedAt: Date;
}
export interface EnteredField { field: string; label: string; value?: string; }
export type NewBrowserTaskRun = Pick<
  BrowserTaskRun,
  "allowedFields" | "extraData" | "familyId" | "goal" | "sandboxSessionId" | "scope" | "startUrl" | "userId"
>;

interface Row {
  id: string; family_id: string; user_id: string; scope: "family" | "personal"; sandbox_session_id: string;
  goal: string; start_url: string | null; allowed_fields: string[]; extra_data: Record<string, string>;
  hint: string | null; status: BrowserTaskStatus; step_count: number; handoff_count: number;
  history: StepRecord[]; entered: EnteredField[]; pending_action: PendingAction | null;
  failed_actions: Record<string, number>; last_signature: string | null; last_url: string | null; active_millis: number;
  started_at: Date;
}
const COLUMNS = `id, family_id, user_id, scope, sandbox_session_id, goal, start_url, allowed_fields, extra_data, hint,
  status, step_count, handoff_count, history, entered, pending_action, failed_actions, last_signature, last_url,
  active_millis, started_at`;
const ACTIVE = "('running', 'awaiting_confirmation', 'confirming', 'needs_plan')";
const ACTIVE_STATUSES: ReadonlySet<BrowserTaskStatus> = new Set(["awaiting_confirmation", "confirming", "needs_plan", "running"]);

function fromRow(row: Row): BrowserTaskRun {
  return {
    activeMillis: row.active_millis, allowedFields: row.allowed_fields, entered: row.entered, extraData: row.extra_data, failedActions: row.failed_actions,
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
                pending_action = $8, failed_actions = $9, last_signature = $10, last_url = $11,
                active_millis = $12, updated_at = now()
          WHERE id = $1`,
        [run.id, run.hint, run.status, run.stepCount, run.handoffCount, JSON.stringify(run.history),
          JSON.stringify(ACTIVE_STATUSES.has(run.status) ? run.entered : run.entered.map(({ field, label }) => ({ field, label }))),
          run.pendingAction === null ? null : JSON.stringify(run.pendingAction),
          JSON.stringify(run.failedActions), run.lastSignature, run.lastUrl, Math.round(run.activeMillis)],
      );
    },

    /** Adds the field to an active run; returns false when the run is not active any more. */
    async allowField(id: string, field: string): Promise<boolean> {
      const result = await database().query(
        `UPDATE browser_task_runs
            SET allowed_fields = CASE WHEN $2 = ANY(allowed_fields) THEN allowed_fields ELSE array_append(allowed_fields, $2) END,
                updated_at = now()
          WHERE id = $1 AND status IN ${ACTIVE}`,
        [id, field],
      );
      return result.rowCount === 1;
    },

    /** True only for the one caller that moved the row out of `from`. */
    async transition(id: string, from: BrowserTaskStatus, to: BrowserTaskStatus): Promise<boolean> {
      const result = await database().query(
        "UPDATE browser_task_runs SET status = $3, updated_at = now() WHERE id = $1 AND status = $2",
        [id, from, to],
      );
      return result.rowCount === 1;
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
