/**
 * Exactly-once guard for Yandex Go side effects of one tool call (migration 139).
 *
 * Exports:
 * - `runYandexTaxiOperation`: runs an order or a cancellation under the key `session:callId`; a
 *   replay returns the stored result (`replayed: true`) or refuses with an ambiguity code, and a
 *   different input under the same key is refused.
 * - `yandexTaxiOperationRepository`: the PostgreSQL ledger behind it.
 * - `requireYandexTaxiFamilyMember`: the person's family membership, read in PostgreSQL now.
 *
 * Key constructs:
 * - Eve re-runs an interrupted step with the same call id; without the ledger a replayed order could
 *   send a second car (the same reasoning as `lavka_operations`, review of 28 September 2026).
 * - A refusal Yandex Go explained before anything was accepted frees the key, and so does any
 *   failure marked `yandexTaxiNothingSent` (transport) (the re-pricing or re-reading before the side effect
 *   failed, Codex review of 24 October 2026); any other failure keeps it `started`, which a replay
 *   reports as ambiguous.
 * - The person's family membership is re-read in PostgreSQL before the side effect: a member removed
 *   between the turn start and the confirmation spends nothing through the bot. The tool re-reads it
 *   before every action too, so a removed member's turn does not reach the browser at all.
 */
import { AppError, isAppError } from "../app-error.js";
import { database } from "../database.js";
import { sha256Json } from "../json-hash.js";
import { isYandexTaxiNothingSent } from "./yandex-taxi-transport.js";

export type YandexTaxiOperationAction = "cancel" | "order";

export interface YandexTaxiOperationRepository {
  begin(input: { action: YandexTaxiOperationAction; familyId: string; key: string; requestHash: string; userId: string }):
    Promise<{ kind: "started" } | { kind: "existing"; requestHash: string; result: unknown; status: "completed" | "started" }>;
  complete(input: { key: string; result: unknown; userId: string }): Promise<void>;
  release(input: { key: string; userId: string }): Promise<void>;
}

/** Codes after which Yandex Go accepted nothing: retrying the same call is safe. */
const DEFINITIVE_FAILURES: ReadonlySet<string> = new Set([
  "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID",
  "AGENT_YANDEX_TAXI_ACCESS_DENIED",
  "AGENT_YANDEX_TAXI_AUTH_REQUIRED",
  "AGENT_YANDEX_TAXI_BLOCKED",
  "AGENT_YANDEX_TAXI_CANCEL_CHANGED",
  "AGENT_YANDEX_TAXI_CANCEL_UNAVAILABLE",
  "AGENT_YANDEX_TAXI_CAPTCHA",
  "AGENT_YANDEX_TAXI_NO_TARIFFS",
  "AGENT_YANDEX_TAXI_ORDER_ACTIVE",
  "AGENT_YANDEX_TAXI_ORDER_NOT_FOUND",
  "AGENT_YANDEX_TAXI_PAYMENT_CHANGED",
  "AGENT_YANDEX_TAXI_PAYMENT_MISSING",
  "AGENT_YANDEX_TAXI_POINT_REF_INVALID",
  "AGENT_YANDEX_TAXI_PRICE_CHANGED",
  "AGENT_YANDEX_TAXI_RATE_LIMITED",
  "AGENT_YANDEX_TAXI_REJECTED",
  "AGENT_YANDEX_TAXI_TAB_MOVED",
  "AGENT_YANDEX_TAXI_TAB_UNAVAILABLE",
  "AGENT_YANDEX_TAXI_TARIFF_UNAVAILABLE",
  "AGENT_YANDEX_TAXI_ZONE_UNAVAILABLE",
]);

export async function requireYandexTaxiFamilyMember(familyId: string, userId: string): Promise<void> {
  const member = await database().query("SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2", [familyId, userId]);
  if ((member.rowCount ?? 0) === 0) {
    throw new AppError("AGENT_YANDEX_TAXI_ACCESS_DENIED", "Такси заказывают только члены семьи в личном чате");
  }
}

function ambiguity(action: YandexTaxiOperationAction): AppError {
  return action === "order"
    ? new AppError("AGENT_YANDEX_TAXI_ORDER_AMBIGUOUS", "Прошлая попытка заказа могла дойти до Яндекс Go. Не заказывайте снова: посмотрите status")
    : new AppError("AGENT_YANDEX_TAXI_CANCEL_AMBIGUOUS", "Прошлая попытка отмены могла дойти до Яндекс Go. Посмотрите status, прежде чем отменять снова");
}

export async function runYandexTaxiOperation<T>(
  repository: YandexTaxiOperationRepository,
  input: { action: YandexTaxiOperationAction; familyId: string; key: string; request: unknown; userId: string },
  run: () => Promise<T>,
): Promise<{ replayed: boolean; result: T }> {
  const requestHash = sha256Json(input.request);
  const begun = await repository.begin({ action: input.action, familyId: input.familyId, key: input.key, requestHash, userId: input.userId });
  if (begun.kind === "existing") {
    if (begun.requestHash !== requestHash) {
      throw new AppError("AGENT_YANDEX_TAXI_OPERATION_MISMATCH", "Этот вызов уже выполнялся с другими параметрами. Сделайте новый вызов");
    }
    if (begun.status === "completed") return { replayed: true, result: begun.result as T };
    throw ambiguity(input.action);
  }
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if ((isAppError(error) && DEFINITIVE_FAILURES.has(error.code)) || isYandexTaxiNothingSent(error)) {
      await repository.release({ key: input.key, userId: input.userId });
    }
    throw error;
  }
  await repository.complete({ key: input.key, result, userId: input.userId });
  return { replayed: false, result };
}

export const yandexTaxiOperationRepository: YandexTaxiOperationRepository = {
  async begin(input) {
    await requireYandexTaxiFamilyMember(input.familyId, input.userId);
    const inserted = await database().query(
      `INSERT INTO yandex_taxi_operations (user_id, operation_key, action, request_hash, status)
       VALUES ($1, $2, $3, $4, 'started') ON CONFLICT (user_id, operation_key) DO NOTHING RETURNING operation_key`,
      [input.userId, input.key, input.action, input.requestHash],
    );
    if ((inserted.rowCount ?? 0) > 0) return { kind: "started" };
    const existing = await database().query<{ request_hash: string; result: unknown; status: "completed" | "started" }>(
      "SELECT request_hash, result, status FROM yandex_taxi_operations WHERE user_id = $1 AND operation_key = $2",
      [input.userId, input.key],
    );
    const row = existing.rows[0];
    // Released between the insert and the read: the earlier attempt failed definitively.
    if (!row) return await this.begin(input);
    return { kind: "existing", requestHash: row.request_hash, result: row.result, status: row.status };
  },
  async complete(input) {
    await database().query(
      `UPDATE yandex_taxi_operations SET status = 'completed', result = $3::jsonb, completed_at = now()
        WHERE user_id = $1 AND operation_key = $2 AND status = 'started'`,
      [input.userId, input.key, JSON.stringify(input.result ?? null)],
    );
  },
  async release(input) {
    await database().query(
      "DELETE FROM yandex_taxi_operations WHERE user_id = $1 AND operation_key = $2 AND status = 'started'",
      [input.userId, input.key],
    );
  },
};
