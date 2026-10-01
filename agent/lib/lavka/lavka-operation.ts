/**
 * Exactly-once guard for Lavka side effects of one tool call (migration 118).
 *
 * Exports:
 * - `runLavkaOperation`: runs a side effect under a durable key; a replay returns the stored result
 *   (`replayed: true`) or refuses with an ambiguity code, a different input under the same key is
 *   refused. The caller picks the key: a confirmed order is bound to its call id, an `add` to the
 *   turn and its input, because a re-run model step generates the same call under a new id.
 * - `lavkaOperationRepository`: the PostgreSQL ledger behind it.
 * - `LAVKA_DEFINITIVE_FAILURES`: codes after which nothing reached Lavka, so the key is released.
 *
 * Key constructs:
 * - Eve re-runs an interrupted step with the same call id; without this a replayed `add` added the
 *   quantity twice and a replayed `order` could submit a second order (review, 28 September 2026).
 * - A thrown error the site explained before any write (validation, lost session, moved tab) frees
 *   the key; any other failure keeps it `started`, which a replay reports as ambiguous.
 */
import { createHash } from "node:crypto";

import { AppError, isAppError } from "../app-error.js";
import { database } from "../database.js";

export type LavkaOperationAction = "add" | "cancel" | "order";

export interface LavkaOperationRepository {
  begin(input: { action: LavkaOperationAction; key: string; requestHash: string; userId: string }):
    Promise<{ kind: "started" } | { kind: "existing"; requestHash: string; result: unknown; status: "completed" | "started" }>;
  complete(input: { key: string; result: unknown; userId: string }): Promise<void>;
  release(input: { key: string; userId: string }): Promise<void>;
}

/** Codes after which the site did not accept the side effect: retrying the same call is safe. */
const LAVKA_DEFINITIVE_FAILURES: ReadonlySet<string> = new Set([
  "AGENT_LAVKA_ADDRESS_CHANGED",
  "AGENT_LAVKA_ADDRESS_REQUIRED",
  "AGENT_LAVKA_AUTH_REQUIRED",
  "AGENT_LAVKA_CART_CHANGED",
  "AGENT_LAVKA_CART_CONFLICT",
  "AGENT_LAVKA_CHECKOUT_BLOCKED",
  "AGENT_LAVKA_ITEM_DROPPED",
  "AGENT_LAVKA_PAYMENT_CHANGED",
  "AGENT_LAVKA_PAYMENT_MISSING",
  "AGENT_LAVKA_PRICE_REQUIRED",
  "AGENT_LAVKA_RATE_LIMITED",
  "AGENT_LAVKA_REJECTED",
  "AGENT_LAVKA_TAB_MOVED",
  "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID",
]);

function ambiguity(action: LavkaOperationAction): AppError {
  return action === "add"
    ? new AppError("AGENT_LAVKA_CART_AMBIGUOUS", "Прошлая попытка добавить товар могла дойти до Лавки. Посмотрите корзину (cart), прежде чем добавлять снова")
    : new AppError("AGENT_LAVKA_ORDER_AMBIGUOUS", "Прошлая попытка могла дойти до Лавки. Проверьте заказы (orders), прежде чем повторять");
}

export async function runLavkaOperation<T>(
  repository: LavkaOperationRepository,
  input: { action: LavkaOperationAction; key: string; request: unknown; userId: string },
  run: () => Promise<T>,
): Promise<{ replayed: boolean; result: T }> {
  const requestHash = createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
  const begun = await repository.begin({ action: input.action, key: input.key, requestHash, userId: input.userId });
  if (begun.kind === "existing") {
    if (begun.requestHash !== requestHash) {
      throw new AppError("AGENT_LAVKA_OPERATION_MISMATCH", "Этот вызов уже выполнялся с другими параметрами. Сделайте новый вызов");
    }
    if (begun.status === "completed") return { replayed: true, result: begun.result as T };
    throw ambiguity(input.action);
  }
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if (isAppError(error) && LAVKA_DEFINITIVE_FAILURES.has(error.code)) {
      await repository.release({ key: input.key, userId: input.userId });
    }
    throw error;
  }
  await repository.complete({ key: input.key, result, userId: input.userId });
  return { replayed: false, result };
}

export const lavkaOperationRepository: LavkaOperationRepository = {
  async begin(input) {
    const inserted = await database().query(
      `INSERT INTO lavka_operations (user_id, operation_key, action, request_hash, status)
       VALUES ($1, $2, $3, $4, 'started') ON CONFLICT (user_id, operation_key) DO NOTHING RETURNING operation_key`,
      [input.userId, input.key, input.action, input.requestHash],
    );
    if ((inserted.rowCount ?? 0) > 0) return { kind: "started" };
    const existing = await database().query<{ request_hash: string; result: unknown; status: "completed" | "started" }>(
      "SELECT request_hash, result, status FROM lavka_operations WHERE user_id = $1 AND operation_key = $2",
      [input.userId, input.key],
    );
    const row = existing.rows[0];
    // Released between the insert and the read: the earlier attempt failed definitively.
    if (!row) return await this.begin(input);
    return { kind: "existing", requestHash: row.request_hash, result: row.result, status: row.status };
  },
  async complete(input) {
    await database().query(
      `UPDATE lavka_operations SET status = 'completed', result = $3::jsonb, completed_at = now()
        WHERE user_id = $1 AND operation_key = $2 AND status = 'started'`,
      [input.userId, input.key, JSON.stringify(input.result ?? null)],
    );
  },
  async release(input) {
    await database().query(
      "DELETE FROM lavka_operations WHERE user_id = $1 AND operation_key = $2 AND status = 'started'",
      [input.userId, input.key],
    );
  },
};
