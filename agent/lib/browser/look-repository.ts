/**
 * Durable state of the browser of one trust zone: the last look and what happened on it.
 *
 * Exports:
 * - `BrowserLook`, `PendingClick`, `VisionView`: the row as the tools see it.
 * - `createLookRepository`: read, replace on a new look, record typed data, hold or clear the
 *   pending click, reset.
 * - `lookRepository`: production repository.
 *
 * Key constructs:
 * - One row per sandbox session, replaced by every look. `browser_act` and `browser_confirm`
 *   arrive as separate tool calls, possibly from a child session and a root session, and read the
 *   same row: the numbers of one epoch mean the same elements to both.
 * - `entered` follows the page chain: a new origin or path clears it, a query change (a widget's
 *   own state) keeps it. The gate reads it, the confirmation window shows it, nothing else does.
 */
import { database } from "../database.js";
import type { EnteredField } from "./gate.js";
import type { PageElement, PageView } from "./page-view.js";

export interface VisionView { blockers: string[]; note: string; screen: string; selected: string[]; }
export interface PendingClick { element: PageElement; epoch: string; n: number; reason: string; }
export interface BrowserLook {
  elements: PageElement[];
  entered: EnteredField[];
  epoch: string;
  familyId: string;
  pending: PendingClick | null;
  sandboxSessionId: string;
  screenshotPath: string | null;
  steps: number;
  title: string;
  updatedAt: Date;
  url: string;
  textHash: number;
  view: VisionView | null;
  viewHash: string;
}

interface Row {
  elements: PageElement[]; entered: EnteredField[]; epoch: string; family_id: string; pending: PendingClick | null;
  sandbox_session_id: string; screenshot_path: string | null; steps: number; title: string; updated_at: Date; url: string;
  text_hash: number; view: VisionView | null; view_hash: string;
}
const COLUMNS = "sandbox_session_id, family_id, epoch, url, title, elements, view_hash, text_hash, view, screenshot_path, entered, pending, steps, updated_at";

function fromRow(row: Row): BrowserLook {
  return {
    elements: row.elements, entered: row.entered, epoch: row.epoch, familyId: row.family_id, pending: row.pending,
    sandboxSessionId: row.sandbox_session_id, screenshotPath: row.screenshot_path, steps: row.steps, title: row.title,
    textHash: row.text_hash, updatedAt: row.updated_at, url: row.url, view: row.view, viewHash: row.view_hash,
  };
}

/** The same page chain: same origin and path; the query is a widget's own state. */
function samePageChain(a: string, b: string): boolean {
  try {
    const x = new URL(a); const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}

export function createLookRepository() {
  return {
    async get(sandboxSessionId: string, familyId: string): Promise<BrowserLook | null> {
      const result = await database().query<Row>(
        `SELECT ${COLUMNS} FROM browser_looks WHERE sandbox_session_id = $1 AND family_id = $2`,
        [sandboxSessionId, familyId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },

    /** Replaces the look; keeps `entered` on the same page chain; a look never keeps a pending click. */
    async saveLook(input: {
      familyId: string; sandboxSessionId: string; screenshotPath: string | null; view: PageView; viewHash: string; vision: VisionView | null;
    }): Promise<BrowserLook> {
      const result = await database().query<Row>(
        `INSERT INTO browser_looks
           (sandbox_session_id, family_id, epoch, url, title, elements, view_hash, text_hash, view, screenshot_path, entered, pending, steps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $11, $8, $9, '[]'::jsonb, NULL, 0)
         ON CONFLICT (sandbox_session_id) DO UPDATE
           SET family_id = EXCLUDED.family_id, epoch = EXCLUDED.epoch, url = EXCLUDED.url, title = EXCLUDED.title,
               elements = EXCLUDED.elements, view_hash = EXCLUDED.view_hash, text_hash = EXCLUDED.text_hash, view = EXCLUDED.view,
               screenshot_path = EXCLUDED.screenshot_path, pending = NULL, updated_at = now(),
               entered = CASE WHEN $10::boolean THEN browser_looks.entered ELSE '[]'::jsonb END,
               steps = browser_looks.steps + 1
         RETURNING ${COLUMNS}`,
        [
          input.sandboxSessionId, input.familyId, input.view.epoch, input.view.url, input.view.title, JSON.stringify(input.view.elements),
          input.viewHash, input.vision === null ? null : JSON.stringify(input.vision), input.screenshotPath,
          await (async () => {
            const previous = await this.get(input.sandboxSessionId, input.familyId);
            return previous !== null && samePageChain(previous.url, input.view.url);
          })(),
          input.view.textHash,
        ],
      );
      return fromRow(result.rows[0]!);
    },

    async addEntered(sandboxSessionId: string, familyId: string, entry: EnteredField): Promise<void> {
      await database().query(
        `UPDATE browser_looks SET entered = entered || $3::jsonb, updated_at = now()
          WHERE sandbox_session_id = $1 AND family_id = $2`,
        [sandboxSessionId, familyId, JSON.stringify([entry])],
      );
    },

    async setPending(sandboxSessionId: string, familyId: string, pending: PendingClick | null): Promise<void> {
      await database().query(
        `UPDATE browser_looks SET pending = $3, updated_at = now() WHERE sandbox_session_id = $1 AND family_id = $2`,
        [sandboxSessionId, familyId, pending === null ? null : JSON.stringify(pending)],
      );
    },

    async reset(sandboxSessionId: string, familyId: string): Promise<void> {
      await database().query("DELETE FROM browser_looks WHERE sandbox_session_id = $1 AND family_id = $2", [sandboxSessionId, familyId]);
    },
  };
}

export const lookRepository = createLookRepository();
