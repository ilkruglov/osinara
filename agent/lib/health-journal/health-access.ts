/**
 * The health journal's transaction boundary: who may write, in which timezone, and replay safety.
 *
 * Exports:
 * - `HealthTransaction`: the client, owner, family and timezone of one journal operation.
 * - `withHealthTransaction`: authorizes the person, resolves their timezone, refuses the files
 *   mode (unless the operation works in both modes or replays a committed call), runs one
 *   transaction.
 * - `JournalMode`, `JOURNAL_MODES`, `journalMode`, `journalState`, `assertDatabaseJournal`,
 *   `ERASE_RESULT_SQL`: where the journal lives and how many erases it has seen.
 * - `replayable`: runs a write once per Eve call id under the person's lock, returns the stored
 *   result on a replay, and checks the files mode again after both.
 * - `healthError`, `inputInvalid`, `staleVersion`, `notFound`: model-facing errors with their code,
 *   correction and retry verdict.
 * - `civilDate`, `clockTime`, `rejectForeignFields`: shared pieces of the tools' input schemas.
 * - `stampOf`, `requireNotFutureMoment`: the civil date and time a record is stamped with, never
 *   later than now.
 * - `requireDateRange`: a list's period with its default and its limit.
 *
 * Key constructs:
 * - The journal belongs to the person (`owner_user_id`) and lives only in their private chat: a
 *   group id, an external role, another actor or a revoked membership is refused by the same pair
 *   of checks as the shopping list (`family-repository-checks.ts`). The same check runs in their
 *   personal scheduled turns, whose actor is the person.
 * - The timezone is read before the transaction takes its connection, so one operation holds one
 *   pool connection at a time (two each would deadlock the pool of ten under load).
 * - Days are the person's civil days: their own timezone, else the family owner's
 *   (`currentTimeRepository.findTurnTimezone`, the rule of the turn's own clock, kept by the owner
 *   on 11 November 2026); with neither, or a name the runtime does not know, the operation stops
 *   with a named error rather than guessing UTC.
 */
import type { PoolClient } from "pg";
import { z } from "zod";

import { currentTimeRepository } from "../current-time-repository.js";
import { database } from "../database.js";
import { isLivePersonalMember, personalChatUserId } from "../family-repository-checks.js";
import { sha256Json } from "../json-hash.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { type ModelFacingErrorCategory, ModelFacingError } from "../model-facing-error.js";
import { addDays, isRealDate } from "./health-formulas.js";

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;

/** A civil date that exists: «2026-02-31» is refused here, not by PostgreSQL. */
export const civilDate = () => z.string().regex(DATE_PATTERN).refine(isRealDate, "Такой даты нет");

export const clockTime = () => z.string().regex(TIME_PATTERN);

/** Every tool input is one flat object; each action names the fields it accepts. */
export function rejectForeignFields(
  allowed: Readonly<Record<string, readonly string[]>>,
  value: { action: string },
  ctx: z.RefinementCtx,
): void {
  const fields = allowed[value.action] ?? [];
  for (const key of Object.keys(value)) {
    if (key !== "action" && !fields.includes(key))
      ctx.addIssue({ code: "custom", message: `Поле ${key} не относится к ${value.action}` });
  }
}

export const JOURNAL_MODES = ["database", "files"] as const;
/** `database`: the journal tools; `files`: the person keeps the journal in `health/`. */
export type JournalMode = (typeof JOURNAL_MODES)[number];

export interface HealthTransaction {
  /** Works in both modes: the journal's facts, switching the mode, erasing the database copies. */
  anyMode: boolean;
  client: PoolClient;
  familyId: string;
  /** The person's civil time now, `HH:MM`, read from the same moment as `today`. */
  now: string;
  ownerUserId: string;
  timezone: string;
  /** The person's civil date now, `YYYY-MM-DD`. */
  today: string;
}

export function healthError(
  code: string,
  reason: string,
  options: {
    category: ModelFacingErrorCategory;
    correction: string;
    field?: string;
    retryable?: boolean;
  },
): ModelFacingError {
  return new ModelFacingError({
    category: options.category,
    code,
    correction: options.correction,
    ...(options.field === undefined ? {} : { field: options.field }),
    reason,
    retryable:
      options.retryable ?? (options.category === "input" || options.category === "conflict"),
    sideEffectStatus: "not_started",
  });
}

function accessDenied(): ModelFacingError {
  return healthError(
    "AGENT_HEALTH_ACCESS_DENIED",
    "Дневник здоровья ведётся только в личном чате члена семьи",
    {
      category: "authorization",
      correction:
        "Не повторяй вызов. Скажи человеку, что дневник ведётся в его личном чате с Мией, а здесь можно только обсудить питание, сон и нагрузку без записей.",
      retryable: false,
    },
  );
}

function timezoneMissing(): ModelFacingError {
  return healthError(
    "AGENT_HEALTH_TIMEZONE_MISSING",
    "Не задан часовой пояс, поэтому нельзя понять, к какому дню относится запись",
    {
      category: "operation",
      correction:
        "Спроси у человека город или часовой пояс, сохрани его через notification_settings (action=set, timezone в формате IANA) и повтори запись.",
      retryable: false,
    },
  );
}

/**
 * The person's civil date and time now, both from one moment and Node's own tzdata: a date and a
 * time read from two clocks could straddle midnight; no catalog scan in PostgreSQL either.
 */
function civilNow(timezone: string): { now: string; today: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? "";
    return {
      now: `${part("hour")}:${part("minute")}`,
      today: `${part("year")}-${part("month")}-${part("day")}`,
    };
  } catch {
    return null;
  }
}

/** The turn's rule (`findTurnTimezone`): the person's own timezone, else the family owner's. */
async function resolveTimezone(
  ownerUserId: string,
  familyId: string,
): Promise<{ now: string; timezone: string; today: string }> {
  const timezone = await currentTimeRepository.findTurnTimezone(ownerUserId, familyId);
  const clock = timezone === null ? null : civilNow(timezone);
  if (timezone === null || clock === null) throw timezoneMissing();
  return { ...clock, timezone };
}

/** The predicate of an erase in the operations journal: an erase keeps its counts there. */
// Null-safe, so `NOT (${ERASE_RESULT_SQL})` is true for a result without the key.
export const ERASE_RESULT_SQL = "jsonb_typeof(result -> 'erased') IS NOT DISTINCT FROM 'object'";

function fileJournal(): ModelFacingError {
  return healthError(
    "AGENT_HEALTH_FILE_JOURNAL",
    "Человек ведёт дневник в своих файлах (health/), а не в этом дневнике",
    {
      category: "operation",
      correction:
        "Не пользуйся инструментами дневника для этого человека: веди записи, сводки и карточки в его файлах по health/README.md, как раньше. Ничего не потеряно и не стёрто. Режим дневника меняет только сам человек, ради записи его не переключай и не предлагай.",
      retryable: false,
    },
  );
}

const MODE_SQL = "SELECT journal_mode FROM health_profiles WHERE owner_user_id = $1";

export async function journalMode(
  client: Pick<PoolClient, "query">,
  ownerUserId: string,
): Promise<JournalMode> {
  const mode = await client.query<{ journal_mode: JournalMode }>(MODE_SQL, [ownerUserId]);
  return mode.rows[0]?.journal_mode ?? "database";
}

/** The erases and the mode, read together: a card is checked against them after its write. */
export async function journalState(
  client: Pick<PoolClient, "query">,
  ownerUserId: string,
): Promise<{ erases: number; mode: JournalMode }> {
  const state = await client.query<{ erases: number; mode: JournalMode | null }>(
    `SELECT (SELECT count(*)::integer FROM health_operations
              WHERE owner_user_id = $1 AND ${ERASE_RESULT_SQL}) AS erases,
            (${MODE_SQL}) AS mode`,
    [ownerUserId],
  );
  return { erases: state.rows[0]!.erases, mode: state.rows[0]!.mode ?? "database" };
}

async function requireDatabaseJournal(tx: HealthTransaction): Promise<void> {
  if ((await journalMode(tx.client, tx.ownerUserId)) === "files") throw fileJournal();
}

/** The start check: one statement for the mode and for whether this call already committed. */
async function refuseFilesMode(tx: HealthTransaction, operationKey: string): Promise<void> {
  const state = await tx.client.query<{ mode: JournalMode | null; replay: boolean }>(
    `SELECT (${MODE_SQL}) AS mode,
            EXISTS (SELECT 1 FROM health_operations
                     WHERE owner_user_id = $1 AND operation_key = $2) AS replay`,
    [tx.ownerUserId, operationKey],
  );
  if (state.rows[0]!.mode === "files" && !state.rows[0]!.replay) throw fileJournal();
}

async function storedOperation<T>(tx: HealthTransaction, operationKey: string) {
  const stored = await tx.client.query<{ request_hash: string; result: T }>(
    "SELECT request_hash, result FROM health_operations WHERE owner_user_id = $1 AND operation_key = $2",
    [tx.ownerUserId, operationKey],
  );
  return stored.rows[0];
}

/**
 * One journal operation of the person. In the files mode it is refused before it starts, unless it
 * works in both modes (`anyMode`) or replays a call already committed: that replay returns its
 * stored result. A write checks the mode again under the person's lock (`replayable`).
 */
export async function withHealthTransaction<T>(
  auth: MemoryAuthorization,
  options: { anyMode?: boolean; operationKey: string },
  run: (tx: HealthTransaction) => Promise<T>,
): Promise<T> {
  const ownerUserId = personalChatUserId(auth);
  if (ownerUserId === null) throw accessDenied();
  // Before taking the transaction's connection: an operation never holds two pool connections.
  const clock = await resolveTimezone(ownerUserId, auth.familyId);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    if (!(await isLivePersonalMember(client, auth, ownerUserId))) throw accessDenied();
    const tx: HealthTransaction = {
      anyMode: options.anyMode === true,
      client,
      familyId: auth.familyId,
      ownerUserId,
      ...clock,
    };
    if (!tx.anyMode) await refuseFilesMode(tx, options.operationKey);
    const result = await run(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The refusal of `withHealthTransaction` alone, before costly work (reading an archive). */
export async function assertDatabaseJournal(
  auth: MemoryAuthorization,
  operationKey: string,
): Promise<void> {
  await withHealthTransaction(auth, { operationKey }, async () => undefined);
}

/**
 * One write per Eve call id. The stored result is returned as it was, marked `replayed`; the same
 * key with different input is a bug in the caller, never a second write.
 * All writes of one person take one lock: a replay racing its original, two first `set_profile`s,
 * two nights for one date and an erase racing a write each see the other's committed state.
 */
export async function replayable<T extends object>(
  tx: HealthTransaction,
  operationKey: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T & { replayed: boolean }> {
  if (!operationKey || operationKey.length > 500) throw accessDenied();
  const hash = sha256Json(input);
  await tx.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${tx.ownerUserId}:health`,
  ]);
  const previous = await storedOperation<T>(tx, operationKey);
  if (previous) {
    if (previous.request_hash !== hash)
      throw healthError(
        "AGENT_HEALTH_OPERATION_REUSED",
        "Этот вызов уже выполнен с другими данными",
        {
          category: "conflict",
          correction: "Не повторяй вызов; прочитай текущее состояние и сделай новый вызов.",
          retryable: false,
        },
      );
    return { ...previous.result, replayed: true };
  }
  // After the lock and the replay: a switch to files committed while this call waited refuses it,
  // and a write committed before the switch still replays above.
  if (!tx.anyMode) await requireDatabaseJournal(tx);
  const result = await run();
  await tx.client.query(
    `INSERT INTO health_operations (owner_user_id, operation_key, request_hash, result)
     VALUES ($1, $2, $3, $4)`,
    [tx.ownerUserId, operationKey, hash, JSON.stringify(result)],
  );
  return { ...result, replayed: false };
}

export function requireNotFuture(tx: HealthTransaction, date: string, field: string): void {
  if (date > tx.today)
    throw healthError("AGENT_HEALTH_DATE_IN_FUTURE", "Запись не может относиться к будущему дню", {
      category: "input",
      correction: `Проверь ${field}: сегодня у человека ${tx.today}. Если человек планирует, а не записывает, ничего не записывай.`,
      field,
    });
}

/** A moment later than now today is the future too: a planned dinner is not an eaten one. */
export function requireNotFutureMoment(
  tx: HealthTransaction,
  date: string,
  time: string,
  field: string,
): void {
  requireNotFuture(tx, date, field);
  if (date === tx.today && time > tx.now)
    throw healthError("AGENT_HEALTH_DATE_IN_FUTURE", "Это время сегодня ещё не наступило", {
      category: "input",
      correction: `Сейчас у человека ${tx.now}. Если он планирует, а не записывает, ничего не записывай; иначе уточни время.`,
      field,
    });
}

/** A new record's civil date and time: today by default, never the future; now today, noon before. */
export function stampOf(
  tx: HealthTransaction,
  date: string | undefined,
  time: string | undefined,
  field = "date",
): { date: string; time: string } {
  const day = date ?? tx.today;
  const stamp = time ?? (day === tx.today ? tx.now : "12:00");
  requireNotFutureMoment(tx, day, stamp, time === undefined ? field : "time");
  return { date: day, time: stamp };
}

/** A list's period: `defaultDays` ending today unless given, at most `maxDays` long. */
export function requireDateRange(
  tx: HealthTransaction,
  input: { from?: string; to?: string },
  defaultDays: number,
  maxDays: number,
): { from: string; to: string } {
  const to = input.to ?? tx.today;
  const from = input.from ?? addDays(to, -(defaultDays - 1));
  if (from > to || addDays(from, maxDays - 1) < to)
    throw healthError("AGENT_HEALTH_RANGE_INVALID", `Период до ${maxDays} дней, from не позже to`, {
      category: "input",
      correction: "Сузь период и повтори.",
    });
  return { from, to };
}

export function inputInvalid(subject: string, tool: string, hint = ""): never {
  throw healthError("AGENT_HEALTH_INPUT_INVALID", `Проверьте действие и поля: ${subject}`, {
    category: "input",
    correction: `Исправь вызов по схеме ${tool}${hint} и повтори один раз.`,
  });
}

export function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export function staleVersion(what: string): ModelFacingError {
  return healthError("AGENT_HEALTH_VERSION_STALE", `${what} уже изменили`, {
    category: "conflict",
    correction: "Прочитай запись заново и повтори изменение с её текущей version; не угадывай.",
  });
}

export function notFound(what: string, readAction: string): ModelFacingError {
  return healthError("AGENT_HEALTH_RECORD_NOT_FOUND", `${what} не найдена`, {
    category: "not_found",
    correction: `Получи актуальный id через ${readAction} и повтори; если записи нет, ничего не меняй.`,
  });
}
