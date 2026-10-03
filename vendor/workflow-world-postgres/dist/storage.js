import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from "@workflow/errors";
import {
  ATTRIBUTE_MAX_PER_RUN,
  AttributeValidationError,
  EVENT_ID_BODY_LENGTH,
  EVENT_ID_PREFIX,
  EventSchema,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  getMaxEventsPerRun,
  HookSchema,
  isChildEntityCreationEvent,
  isChildEntityCreationEventType,
  isHookEventRequiringExistence,
  isLegacySpecVersion,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  slotToEventId,
  stripEventDataRefs,
  TERMINAL_STEP_STATUSES,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  validateAttributeChanges,
  validateUlidTimestamp,
  WorkflowRunSchema,
} from "@workflow/world";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { monotonicFactory } from "ulid";
import { Schema } from "./drizzle/index.js";
import {
  dropEventLogCache,
  eventLogCacheKey,
  readEventLogCache,
  traceEventLogRead,
  writeEventLogCache,
} from "./osinara-event-log-cache.js";
import { compact } from "./util.js";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Only for legacy (pre-slot) runs; see `allocateEventId`. */
const legacyEventUlid = monotonicFactory();
/**
 * How many positions one insert will try before giving up. Reached only when a
 * run is taking concurrent writes faster than any of them can commit.
 */
const SLOT_INSERT_MAX_ATTEMPTS = 40;
/**
 * Collisions that retry the instant the conflicting writer settles.
 *
 * `ON CONFLICT DO NOTHING` does not skip an uncommitted conflicting row: the
 * unique-index check waits on that writer's transaction and only then reports
 * the conflict, so a lost race has already waited for exactly the thing the
 * next position depends on. Sleeping on top of that adds latency to a
 * suspension flush and buys nothing.
 *
 * The backoff below covers the shape blocking does not: writers that keep
 * arriving while the loop spins, where jittering the herd is the only way the
 * loop converges before it exhausts its attempts.
 */
const SLOT_INSERT_IMMEDIATE_ATTEMPTS = 8;
/** Backoff between collisions, so a wide fan-out spreads rather than lockstep. */
const SLOT_INSERT_BASE_DELAY_MS = 2;
const SLOT_INSERT_MAX_DELAY_MS = 40;
/**
 * Isolation for every transaction an event insert can run inside.
 *
 * {@link insertEventRow} answers a collision by recomputing the next position
 * and inserting again, which only terminates if the retry can see rows
 * committed since the transaction began. Under REPEATABLE READ or SERIALIZABLE
 * it cannot: every attempt reads the transaction's original snapshot, computes
 * the same taken position, and the loop runs to its limit and 503s. READ
 * COMMITTED is Postgres' default, so this is a statement of the requirement
 * rather than a change, and it keeps a database whose
 * `default_transaction_isolation` was raised from turning event writes into
 * timeouts. Inserts outside a transaction need nothing: a lone statement takes
 * a fresh snapshot at every isolation level.
 */
const SLOT_INSERT_TRANSACTION = { isolationLevel: "read committed" };
/** The pg error behind a drizzle wrapper, or an empty shape if there is none. */
function pgErrorOf(err) {
  const direct = err;
  if (direct?.code) {
    return direct;
  }
  return err?.cause ?? {};
}
/**
 * The position a slot-numbered insert takes: one above the highest the run
 * already holds, read inside the INSERT that takes it.
 *
 * Nothing hands out a position ahead of the write that fills it. A writer that
 * loses a dedup race, or whose transaction rolls back, leaves the numbering
 * untouched, so a log missing a position is missing an *event* rather than
 * merely a number. The runtime depends on exactly that: it refuses to replay a
 * log with a hole, because a position nothing occupies cannot be told apart
 * from an event that never happened.
 *
 * A counter column would be cheaper and is what this used to be. It cannot
 * hold that property: a number handed out before the write lands is a number
 * lost whenever the write does not, and the resulting holes are permanent.
 *
 * The subquery is an index-only read of the primary key's last row for the
 * run, not a scan. Ordering is lexicographic, which is the same order as by
 * position because every body is zero-padded to a fixed width.
 *
 * Every numeric parameter is cast explicitly. `substring(text from $n)` with an
 * untyped parameter resolves to the *regular expression* overload rather than
 * the positional one, which quietly returns NULL for every id and hands every
 * writer the first slot.
 */
function nextSlotId(runId) {
  const bodyFrom = sql.raw(String(EVENT_ID_PREFIX.length + 1));
  const width = sql.raw(String(EVENT_ID_BODY_LENGTH));
  const noEvents = sql.raw(String(FIRST_EVENT_SLOT - 1));
  return sql`${EVENT_ID_PREFIX} || lpad((coalesce((select cast(substring(prev.id from ${bodyFrom}) as bigint) from ${Schema.events} prev where prev.run_id = ${runId} order by prev.id desc limit 1), ${noEvents}) + 1)::text, ${width}, '0')`;
}
/**
 * The id an insert for `runId` should allocate with: a slot expression for a
 * slot-numbered run, a fresh ULID for one that predates slots.
 *
 * A row in `workflow_event_slots` is the marker for the first case. Its
 * absence is exactly the "this run predates slots" signal, which is why the
 * table is still read even though nothing advances it any more.
 *
 * A legacy run keeps minting under the original `wevt_` prefix rather than
 * moving to `evnt_`: a mid-life prefix change would sort every new event
 * before every old one, since `evnt_` < `wevt_`.
 */
/**
 * Runs this process has seen marked as slot-numbered (Osinara fork, 4 October
 * 2026). The marker is never removed while a run lives, so once seen it holds;
 * only a run without one is re-read, because the marker could still be inserted
 * by a creation in flight. Before this every event cost one marker read, about
 * ten a turn and the fifth most time of all Workflow statements in a load run.
 * The set is bounded by a plain reset: a miss after it costs one read again.
 */
const SLOT_MARKED_RUNS_MAX = 50_000;
const slotMarkedRuns = new Set();
function rememberSlotMarker(runId) {
  if (slotMarkedRuns.size >= SLOT_MARKED_RUNS_MAX) slotMarkedRuns.clear();
  slotMarkedRuns.add(runId);
}
async function allocateEventId(db, runId) {
  if (slotMarkedRuns.has(runId)) return nextSlotId(runId);
  const [row] = await db
    .select({ runId: Schema.eventSlots.runId })
    .from(Schema.eventSlots)
    .where(eq(Schema.eventSlots.runId, runId))
    .limit(1);
  if (!row) return `wevt_${legacyEventUlid()}`;
  rememberSlotMarker(runId);
  return nextSlotId(runId);
}
/**
 * Inserts one event row, retrying while the position it computed is taken.
 *
 * The primary-key conflict is absorbed by `ON CONFLICT DO NOTHING` rather than
 * raised, so a lost race costs a retry instead of the enclosing transaction —
 * an error inside a transaction would poison it, and these inserts run in one.
 * Every other unique violation still raises, which is what lets callers
 * translate a dedup conflict on `workflow_events_entity_creation_unique`.
 *
 * Returns `undefined` only for an id that is a plain string (a legacy ULID, or
 * the reserved first slot), where a conflict is the caller's answer rather
 * than something to retry.
 */
async function insertEventRow(db, values) {
  const runId = values.runId;
  const allocates = typeof values.eventId !== "string";
  for (let attempt = 0; ; attempt++) {
    const [row] = await db
      .insert(Schema.events)
      .values(values)
      .onConflictDoNothing({
        target: [Schema.events.runId, Schema.events.eventId],
      })
      .returning({
        eventId: Schema.events.eventId,
        createdAt: Schema.events.createdAt,
      });
    if (row) {
      return row;
    }
    if (!allocates || attempt >= SLOT_INSERT_MAX_ATTEMPTS) {
      if (!allocates) {
        return undefined;
      }
      throw new WorkflowWorldError(
        `Could not allocate an event slot for run "${runId}" after ${SLOT_INSERT_MAX_ATTEMPTS} attempts`,
        { status: 503 },
      );
    }
    if (attempt >= SLOT_INSERT_IMMEDIATE_ATTEMPTS) {
      const delay = Math.min(
        SLOT_INSERT_MAX_DELAY_MS,
        SLOT_INSERT_BASE_DELAY_MS *
          2 ** (attempt - SLOT_INSERT_IMMEDIATE_ATTEMPTS),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * delay),
      );
    }
  }
}
/**
 * Marks a run being created as slot-numbered and returns its first event id.
 *
 * The row records the scheme and nothing else; positions come from the log
 * itself, see {@link nextSlotId}.
 *
 * `DO NOTHING` on conflict because the arbitration that matters is the event
 * insert: two writers racing one run_created both take the first slot, and the
 * composite events primary key rejects the loser.
 */
async function openEventSlots(db, runId) {
  await db.insert(Schema.eventSlots).values({ runId }).onConflictDoNothing();
  // Inside the creation transaction: should it roll back, the run row goes
  // with it and a later creation of the same id opens the marker again.
  rememberSlotMarker(runId);
  return slotToEventId(FIRST_EVENT_SLOT);
}
/**
 * Inserts a run, its slot marker and its run_created event in one
 * transaction; `undefined` when the run already exists.
 *
 * Osinara fork (3 October 2026). Upstream wrote the three rows as separate
 * statements, so a run_started from the queue could read the committed run in
 * the gap before its slot marker, take it for a pre-slot run and mint a
 * `wevt_` ULID; every replay of that run then failed with "Event id is not
 * slot-numbered" (59 runs stuck at run_created in a 10 000-family load run).
 * Inside the transaction nobody sees the run before its first event: a
 * concurrent resilient start waits on the run's primary key and then finds
 * run_created in slot 1.
 */
async function insertRunWithCreatedEvent(drizzle, runValues, eventValues) {
  return drizzle.transaction(async (tx) => {
    const [runValue] = await tx
      .insert(Schema.runs)
      .values(runValues)
      .onConflictDoNothing()
      .returning();
    if (!runValue) {
      return undefined;
    }
    const event = await insertEventRow(tx, {
      ...eventValues,
      runId: runValues.runId,
      eventId: await openEventSlots(tx, runValues.runId),
      eventType: "run_created",
    });
    if (!event) {
      throw new EntityConflictError(
        `run_created for run "${runValues.runId}" could not be created`,
      );
    }
    return { event, runValue };
  }, SLOT_INSERT_TRANSACTION);
}
/**
 * The report half of bump-and-report: the events sitting on the slots between
 * the one the writer asked for and the one its write actually landed on.
 *
 * Returns `undefined` when there is nothing to report — the write took the slot
 * it asked for, the run is not slot-numbered, or the caller sent a count from a
 * log that is already ahead of this write.
 *
 * The set can be short of the slot span it covers. A position is taken by the
 * INSERT that computes it, and that INSERT commits on its own, so at the moment
 * this reads the span a concurrent writer holding a lower position may not have
 * committed yet. Its row appears shortly after and no position is left behind,
 * because a write that fails never took one. `hasMore` says the report is a
 * lower bound for now rather than a permanent one, and it is advisory either
 * way: the caller's ordinary incremental read still runs.
 */
async function reportSkippedSlots(
  db,
  runId,
  committedEventId,
  askedFor,
  resolveData,
) {
  const committedSlot = eventIdToSlot(committedEventId);
  if (
    committedSlot === null ||
    askedFor < FIRST_EVENT_SLOT ||
    committedSlot <= askedFor + 1
  ) {
    return undefined;
  }
  const rows = await db
    .select()
    .from(Schema.events)
    .where(
      and(
        eq(Schema.events.runId, runId),
        gt(Schema.events.eventId, slotToEventId(askedFor)),
        lt(Schema.events.eventId, committedEventId),
      ),
    )
    .orderBy(Schema.events.eventId);
  const events = rows.map((row) => {
    row.eventData ||= row.eventDataJson;
    return stripEventDataRefs(EventSchema.parse(compact(row)), resolveData);
  });
  return {
    events,
    hasMore: events.length < committedSlot - askedFor - 1,
  };
}
function getHookRetentionLimitMs() {
  const days = Number(
    process.env.WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS ?? 30,
  );
  if (!Number.isFinite(days) || days <= 0) {
    throw new WorkflowWorldError(
      "WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS must be a positive number",
      { status: 400 },
    );
  }
  return days * DAY_MS;
}
/**
 * Read helper for the deprecated `error` text column (legacy: JSON-stringified
 * `StructuredError`). In the current event-sourced model, the `error` field on
 * entities is `SerializedData` (Uint8Array) produced by the new error
 * serialization pipeline; legacy text-column records pre-date that pipeline
 * and cannot be hydrated back into the original thrown value.
 *
 * Returns `null` unconditionally so downstream consumers treat legacy errors
 * as absent rather than receiving a shape that `hydrateStepError` /
 * `hydrateRunError` can't process. Callers that need to inspect the raw
 * legacy payload should read the `errorJson` column directly.
 */
function parseErrorJson(_errorJson) {
  return null;
}
/**
 * Pass-through helper kept for backwards compatibility with the run read path.
 * In the current event-sourced model, `error` is already `SerializedData`
 * (Uint8Array) on the entity, and any legacy `errorStack` / `errorCode`
 * fields are no longer populated by the current write path.
 */
function deserializeRunError(run) {
  // Drop any stale legacy-only fields we might still encounter on read.
  const { errorStack: _errorStack, ...rest } = run;
  return rest;
}
/**
 * Deserialize step data, mapping DB columns to interface fields.
 * The error field should already be deserialized from CBOR or fallback to errorJson.
 */
function deserializeStepError(step) {
  const { startedAt, ...rest } = step;
  return {
    ...rest,
    startedAt,
  };
}
export function createRunsStorage(drizzle) {
  const { runs } = Schema;
  const get = drizzle
    .select()
    .from(runs)
    .where(eq(runs.runId, sql.placeholder("id")))
    .limit(1)
    .prepare("workflow_runs_get");
  return {
    get: async (id, params) => {
      const [value] = await get.execute({ id });
      if (!value) {
        throw new WorkflowRunNotFoundError(id);
      }
      value.output ||= value.outputJson;
      value.input ||= value.inputJson;
      value.executionContext ||= value.executionContextJson;
      value.error ||= parseErrorJson(value.errorJson);
      const deserialized = deserializeRunError(compact(value));
      const parsed = WorkflowRunSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? "all";
      return filterRunData(parsed, resolveData);
    },
    getMany: async (ids, params) => {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) {
        return [];
      }
      const values = await drizzle
        .select()
        .from(runs)
        .where(inArray(runs.runId, uniqueIds));
      const resolveData = params?.resolveData ?? "all";
      const runsById = new Map(
        values.map((value) => {
          value.output ||= value.outputJson;
          value.input ||= value.inputJson;
          value.executionContext ||= value.executionContextJson;
          value.error ||= parseErrorJson(value.errorJson);
          const parsed = WorkflowRunSchema.parse(
            deserializeRunError(compact(value)),
          );
          return [value.runId, filterRunData(parsed, resolveData)];
        }),
      );
      return ids.map((id) => runsById.get(id) ?? null);
    },
    list: async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;
      const all = await drizzle
        .select()
        .from(runs)
        .where(
          and(
            map(fromCursor, (c) => lt(runs.runId, c)),
            map(params?.workflowName, (wf) => eq(runs.workflowName, wf)),
            map(params?.status, (wf) => eq(runs.status, wf)),
          ),
        )
        .orderBy(desc(runs.runId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;
      const resolveData = params?.resolveData ?? "all";
      return {
        data: values.map((v) => {
          v.output ||= v.outputJson;
          v.input ||= v.inputJson;
          v.executionContext ||= v.executionContextJson;
          v.error ||= parseErrorJson(v.errorJson);
          const deserialized = deserializeRunError(compact(v));
          const parsed = WorkflowRunSchema.parse(deserialized);
          return filterRunData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    },
    experimentalSetAttributes: async (runId, changes, options) => {
      // Load existing attributes so the SDK-shape validator can produce
      // a precise error message (cap, duplicate keys, reserved prefix,
      // byte length). The authoritative cap enforcement happens inside
      // the UPDATE statement below — see the `WHERE` clause — so the
      // race between this read and the UPDATE cannot push the row past
      // the per-run cap.
      const [existing] = await drizzle
        .select({ attributes: runs.attributes })
        .from(runs)
        .where(eq(runs.runId, runId))
        .limit(1);
      if (!existing) {
        throw new WorkflowRunNotFoundError(runId);
      }
      try {
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(existing.attributes ?? {}),
          allowReservedAttributes: options?.allowReservedAttributes,
        });
      } catch (err) {
        if (err instanceof AttributeValidationError) throw err;
        throw err;
      }
      // Build a single SQL expression that applies all changes
      // atomically. Sets fold into nested `jsonb_set` calls; removes
      // fold into chained `-` (delete) operators.
      let expr = sql`COALESCE(${runs.attributes}, '{}'::jsonb)`;
      for (const { key, value } of changes) {
        if (value === null) {
          expr = sql`${expr} - ${key}`;
        } else {
          expr = sql`jsonb_set(${expr}, ARRAY[${key}]::text[], to_jsonb(${value}::text), true)`;
        }
      }
      // Atomic cap enforcement: only commit the UPDATE if the
      // post-merge key count fits the per-run cap. Computed against
      // the *current* row state, so two concurrent writers adding
      // disjoint keys at the cap boundary cannot both succeed.
      // Drizzle re-renders `expr` twice in the SQL (`SET attributes =
      // ...` + the count check); `jsonb_set` is cheap so the
      // duplication is harmless.
      const [updated] = await drizzle
        .update(runs)
        .set({
          attributes: expr,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runs.runId, runId),
            sql`(SELECT COUNT(*) FROM jsonb_object_keys(${expr})) <= ${ATTRIBUTE_MAX_PER_RUN}`,
          ),
        )
        .returning({ attributes: runs.attributes });
      if (!updated) {
        // Either the run vanished mid-call, or the cap-check WHERE
        // clause rejected the UPDATE. Re-read to disambiguate.
        const [stillThere] = await drizzle
          .select({ attributes: runs.attributes })
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (!stillThere) {
          throw new WorkflowRunNotFoundError(runId);
        }
        throw new AttributeValidationError(
          `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN} after concurrent write`,
        );
      }
      return { attributes: updated.attributes ?? {} };
    },
  };
}
function map(obj, fn) {
  return obj ? fn(obj) : undefined;
}
/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
 * Legacy runs use different behavior:
 * - run_cancelled: Skip event storage, directly update run
 * - wait_completed: Store event only (no entity mutation)
 * - hook_received: Store event only (hooks exist via old system, no entity mutation)
 * - Other events: Throw error (not supported for legacy runs)
 */
async function handleLegacyEventPostgres(
  drizzle,
  runId,
  eventId,
  data,
  currentRun,
  params,
) {
  const resolveData = params?.resolveData ?? "all";
  switch (data.eventType) {
    case "run_cancelled": {
      // Legacy: Skip event storage, directly update run to cancelled
      const now = new Date();
      // Update run status to cancelled
      await drizzle
        .update(Schema.runs)
        .set({
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(Schema.runs.runId, runId));
      // Delete all hooks and waits for this run
      await Promise.all([
        drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, runId)),
        drizzle.delete(Schema.waits).where(eq(Schema.waits.runId, runId)),
      ]);
      // Fetch updated run for return value
      const [updatedRun] = await drizzle
        .select()
        .from(Schema.runs)
        .where(eq(Schema.runs.runId, runId))
        .limit(1);
      // Return without event (legacy behavior skips event storage)
      // Type assertion: EventResult expects WorkflowRun, filterRunData may return WorkflowRunWithoutData
      return {
        run: updatedRun
          ? filterRunData(deserializeRunError(compact(updatedRun)), resolveData)
          : undefined,
      };
    }
    case "wait_completed":
    case "hook_received": {
      // Legacy: Store event only (no entity mutation)
      // - wait_completed: for replay purposes
      // - hook_received: hooks exist via old system, just record the event
      //
      // hook_received additionally guards against a concurrent (or already
      // committed) terminal transition, mirroring the current-spec
      // hook_received transaction below: `FOR UPDATE` takes the run row
      // lock, blocking until any in-flight terminal UPDATE (including the
      // legacy run_cancelled path above) commits, then observes the
      // post-commit status.
      const insertLegacyEvent = (tx) =>
        tx
          .insert(Schema.events)
          .values({
            runId,
            eventId,
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: "eventData" in data ? data.eventData : undefined,
            specVersion: SPEC_VERSION_CURRENT,
          })
          .returning({ createdAt: Schema.events.createdAt });
      const [insertedEvent] =
        data.eventType === "hook_received"
          ? await drizzle.transaction(async (tx) => {
              const [runRow] = await tx
                .select({ status: Schema.runs.status })
                .from(Schema.runs)
                .where(eq(Schema.runs.runId, runId))
                .for("update")
                .limit(1);
              if (!runRow) {
                throw new WorkflowRunNotFoundError(runId);
              }
              if (isTerminalWorkflowRunStatus(runRow.status)) {
                throw new RunExpiredError(
                  `Workflow run "${runId}" is already in terminal state "${runRow.status}"`,
                );
              }
              return insertLegacyEvent(tx);
            }, SLOT_INSERT_TRANSACTION)
          : await insertLegacyEvent(drizzle);
      const event = EventSchema.parse({
        ...data,
        ...insertedEvent,
        runId,
        eventId,
      });
      return { event: stripEventDataRefs(event, resolveData) };
    }
    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || "undefined"}). ` +
          `Please upgrade @workflow packages.`,
      );
  }
}
export function createEventsStorage(drizzle) {
  const hookRetentionLimitMs = getHookRetentionLimitMs();
  const ulid = monotonicFactory();
  const { events } = Schema;
  const ownerRunIsTerminal = drizzle
    .select({ runId: Schema.runs.runId })
    .from(Schema.runs)
    .where(
      and(
        eq(Schema.runs.runId, Schema.hooks.runId),
        inArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES),
      ),
    );
  const hookRetentionEnded = or(
    isNull(Schema.hooks.tokenRetentionUntil),
    lte(Schema.hooks.tokenRetentionUntil, sql`now()`),
  );
  // Prepared statements for validation queries (performance optimization)
  const getRunForValidation = drizzle
    .select({
      status: Schema.runs.status,
      specVersion: Schema.runs.specVersion,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, sql.placeholder("runId")))
    .limit(1)
    .prepare("events_get_run_for_validation");
  const getStepForValidation = drizzle
    .select({
      status: Schema.steps.status,
      startedAt: Schema.steps.startedAt,
      retryAfter: Schema.steps.retryAfter,
    })
    .from(Schema.steps)
    .where(
      and(
        eq(Schema.steps.runId, sql.placeholder("runId")),
        eq(Schema.steps.stepId, sql.placeholder("stepId")),
      ),
    )
    .limit(1)
    .prepare("events_get_step_for_validation");
  const getHookByToken = drizzle
    .select({ hookId: Schema.hooks.hookId, runId: Schema.hooks.runId })
    .from(Schema.hooks)
    .where(
      and(
        eq(Schema.hooks.token, sql.placeholder("token")),
        or(
          gt(Schema.hooks.tokenRetentionUntil, sql`now()`),
          notExists(ownerRunIsTerminal),
        ),
      ),
    )
    .limit(1)
    .prepare("events_get_hook_by_token");
  // Used to distinguish a real same-hook duplicate from an orphaned
  // hook row left behind by a process / database interruption between
  // the hook INSERT and the events INSERT below (see the recovery
  // logic in the hook_created branch).
  const getHookCreatedEvent = drizzle
    .select({ eventId: events.eventId })
    .from(events)
    .where(
      and(
        eq(events.runId, sql.placeholder("runId")),
        eq(events.correlationId, sql.placeholder("correlationId")),
        eq(events.eventType, sql.placeholder("eventType")),
      ),
    )
    .limit(1)
    .prepare("events_get_hook_created_for_run_correlation");
  const getWaitForValidation = drizzle
    .select({
      status: Schema.waits.status,
    })
    .from(Schema.waits)
    .where(eq(Schema.waits.waitId, sql.placeholder("waitId")))
    .limit(1)
    .prepare("events_get_wait_for_validation");
  return {
    async create(runId, data, params) {
      if (
        data.eventType === "hook_created" &&
        data.eventData.tokenRetentionUntil !== undefined &&
        data.eventData.tokenRetentionUntil.getTime() >
          Date.now() + hookRetentionLimitMs
      ) {
        throw new WorkflowWorldError(
          `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the Postgres World.`,
          { status: 400 },
        );
      }
      // The id this call's event took, known only once its insert has
      // committed: on a slot-numbered run the position is chosen inside the
      // INSERT, so there is nothing to read before it.
      let eventId;
      // Lazy, because on a legacy run this mints a ULID and on a slot run it
      // reads which of the two schemes applies. Every caller below awaits it
      // immediately before its insert. A caller that has already fixed the id
      // — run_created, which always takes the first slot — gets that back.
      const getEventId = async (db = drizzle) =>
        eventId ?? (await allocateEventId(db, effectiveRunId));
      // For run_created events, use client-provided runId or generate one server-side
      let effectiveRunId;
      if (data.eventType === "run_created" && (!runId || runId === "")) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error("runId is required for non-run_created events");
      } else {
        effectiveRunId = runId;
      }
      // Validate client-provided runId timestamp is within acceptable threshold
      if (data.eventType === "run_created" && runId && runId !== "") {
        const validationError = validateUlidTimestamp(effectiveRunId, "wrun_");
        if (validationError) {
          throw new WorkflowWorldError(validationError);
        }
      }
      // specVersion is always sent by the runtime, but we provide a fallback for safety
      const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
      // Track entity created/updated for EventResult
      let run;
      let step;
      let hook;
      let wait;
      // Lazy step start: set true when this step_started atomically created
      // the step (the caller won the create-claim). Surfaced on EventResult
      // as the runtime's exactly-once ownership signal.
      let stepCreatedLazily = false;
      const now = new Date();
      // Terminal step statuses for use in SQL WHERE clauses (atomic guard).
      // Must match the Vercel world's conditional expressions:
      //   ne(status, 'completed') AND ne(status, 'failed') AND ne(status, 'cancelled')
      const terminalStepStatuses = [...TERMINAL_STEP_STATUSES];
      // ============================================================
      // VALIDATION: Terminal state and event ordering checks
      // ============================================================
      // Get current run state for validation (if not creating a new run)
      // Skip run validation for step_completed and step_retrying - they only operate
      // on running steps, and running steps are always allowed to modify regardless
      // of run state. This optimization saves database queries per step event.
      let currentRun = null;
      const skipRunValidationEvents = ["step_completed", "step_retrying"];
      if (
        data.eventType !== "run_created" &&
        !skipRunValidationEvents.includes(data.eventType)
      ) {
        // Use prepared statement for better performance
        const [runValue] = await getRunForValidation.execute({
          runId: effectiveRunId,
        });
        currentRun = runValue ?? null;
        // Resilient start: run_started on non-existent run with eventData
        // creates the run first, so the queue can bootstrap a run that
        // failed to create during start().
        if (
          data.eventType === "run_started" &&
          !currentRun &&
          "eventData" in data &&
          data.eventData
        ) {
          const runInputData = data.eventData;
          if (
            runInputData.deploymentId &&
            runInputData.workflowName &&
            runInputData.input !== undefined
          ) {
            validateAttributeChanges(
              Object.entries(runInputData.attributes ?? {}).map(
                ([key, value]) => ({ key, value }),
              ),
              {
                allowReservedAttributes:
                  runInputData.allowReservedAttributes === true,
              },
            );
            // Create run + run_created event atomically. The
            // transaction ensures we never have an orphaned run
            // without its run_created event.
            const created = await insertRunWithCreatedEvent(
              drizzle,
              {
                runId: effectiveRunId,
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                specVersion: effectiveSpecVersion,
                input: runInputData.input,
                executionContext: runInputData.executionContext,
                attributes: runInputData.attributes,
                // Must be mirrored here too: this is the path that recreates a
                // run from the queued message, which is exactly when the key
                // would otherwise be lost for the rest of the run's life.
                encryptionPublicKey: runInputData.encryptionPublicKey,
                status: "pending",
              },
              {
                eventData: {
                  deploymentId: runInputData.deploymentId,
                  workflowName: runInputData.workflowName,
                  input: runInputData.input,
                  executionContext: runInputData.executionContext,
                  attributes: runInputData.attributes,
                  allowReservedAttributes: runInputData.allowReservedAttributes,
                  encryptionPublicKey: runInputData.encryptionPublicKey,
                },
                specVersion: effectiveSpecVersion,
              },
            );
            const createdRun = created?.runValue;
            if (createdRun) {
              currentRun = {
                status: "pending",
                specVersion: effectiveSpecVersion,
              };
            } else {
              // Run already exists (concurrent run_created won the
              // race). Re-read so downstream logic sees the real state.
              const [runValue] = await getRunForValidation.execute({
                runId: effectiveRunId,
              });
              currentRun = runValue ?? null;
            }
          }
        }
      }
      // ============================================================
      // VERSION COMPATIBILITY: Check run spec version
      // ============================================================
      // For events that have fetched the run, check version compatibility.
      // Skip for run_created (no existing run) and runtime events (step_completed, step_retrying).
      if (currentRun) {
        // Check if run requires a newer world version
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new RunNotSupportedError(
            currentRun.specVersion,
            SPEC_VERSION_CURRENT,
          );
        }
        // Route to legacy handler for pre-event-sourcing runs. A run this old
        // is ULID-numbered by definition, so the id is minted here rather than
        // read out of a slot marker the run cannot have.
        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEventPostgres(
            drizzle,
            effectiveRunId,
            `wevt_${legacyEventUlid()}`,
            data,
            currentRun,
            params,
          );
        }
      }
      if (
        !currentRun &&
        (data.eventType === "attr_set" || data.eventType === "run_started")
      ) {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      // Lazy step start: a step_started carrying step-creation data
      // (stepName + input) may arrive with no prior step_created — it creates
      // the step on the fly (see the materialization block below). This
      // mirrors the resilient run_started path. Detect it here so the
      // entity-creation terminal-run guard treats it like a creation and the
      // "step must exist" ordering guard below doesn't reject it.
      const createsChildEntity = isChildEntityCreationEvent(data);
      const lazyStepStart =
        createsChildEntity && data.eventType === "step_started";
      // Run terminal state validation
      if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (
          data.eventType === "run_cancelled" &&
          currentRun.status === "cancelled"
        ) {
          // Get full run for return value
          const [fullRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);
          // Create the event (still record it)
          const value = await insertEventRow(drizzle, {
            runId: effectiveRunId,
            eventId: await getEventId(),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: "eventData" in data ? data.eventData : undefined,
            specVersion: effectiveSpecVersion,
          });
          if (!value) {
            throw new EntityConflictError(
              `run_cancelled for run "${effectiveRunId}" could not be created`,
            );
          }
          const result = {
            ...data,
            ...value,
            runId: effectiveRunId,
          };
          const parsed = EventSchema.parse(result);
          const resolveData = params?.resolveData ?? "all";
          return {
            event: stripEventDataRefs(parsed, resolveData),
            run: fullRun ? deserializeRunError(compact(fullRun)) : undefined,
          };
        }
        // For run_started on terminal runs, use RunExpiredError so the
        // runtime knows to exit without retrying.
        if (data.eventType === "run_started") {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`,
          );
        }
        // Other run state transitions are not allowed on terminal runs
        if (isTerminalRunEventType(data.eventType)) {
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${currentRun.status}"`,
          );
        }
        // Creating new entities on terminal runs is not allowed. A lazy
        // step_started creates a step, so it is rejected here too — a bare
        // (non-lazy) step_started falls through to the step-validation block
        // below, which uses RunExpiredError for terminal runs.
        if (createsChildEntity) {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
          );
        }
        if (data.eventType === "attr_set") {
          throw new EntityConflictError(
            `Cannot set attributes on run in terminal state "${currentRun.status}"`,
          );
        }
      }
      // Step-related event validation (ordering and terminal state)
      // Fetch status + startedAt so we can reuse for step_started (avoid double read)
      // Skip validation for step_completed/step_failed - use conditional UPDATE instead
      let validatedStep = null;
      const stepEventsNeedingValidation = ["step_started", "step_retrying"];
      if (
        stepEventsNeedingValidation.includes(data.eventType) &&
        data.correlationId
      ) {
        // Use prepared statement for better performance
        const [existingStep] = await getStepForValidation.execute({
          runId: effectiveRunId,
          stepId: data.correlationId,
        });
        validatedStep = existingStep ?? null;
        // Event ordering: step must exist before these events — except on the
        // lazy-start path, where step_started creates the step itself.
        if (!validatedStep && !lazyStepStart) {
          throw new WorkflowWorldError(
            `Step "${data.correlationId}" not found`,
          );
        }
        // Lazy start exactly-once gate: a lazy step_started always CREATES the
        // step (the owned-inline path only sends one for a step whose
        // step_created it deferred). If the step already exists, a concurrent
        // handler won the create — this caller is a loser and must not start or
        // run the step. Throw EntityConflictError so the runtime's executeStep
        // maps it to `skipped`. Critical: the start UPDATE below permits
        // re-starting a non-terminal step (retries rely on that), so without
        // this gate a loser would re-start a running step and run the body a
        // second time. (A concurrent create that lands after this read is also
        // caught by the onConflictDoNothing()+returning() claim below.)
        if (lazyStepStart && validatedStep) {
          throw new EntityConflictError(
            `Step "${data.correlationId}" already created`,
          );
        }
        // Terminal-state checks only apply when the step already exists.
        // validatedStep is null only on the lazy-start path (no step yet),
        // where there is nothing terminal to guard against.
        if (validatedStep) {
          // Step terminal state validation
          if (isTerminalStepStatus(validatedStep.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${validatedStep.status}"`,
            );
          }
          // On terminal runs: only allow completing/failing in-progress steps
          if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
            if (validatedStep.status !== "running") {
              throw new RunExpiredError(
                `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              );
            }
          }
        }
      }
      // Hook-related event validation (existence).
      //
      // An unlocked read outside any transaction, so it settles only the case
      // where the hook was already gone when the request arrived. It is NOT
      // what orders a delivery against a disposal: the disposal can commit in
      // the gap between this read and the append. Both writers take the hook's
      // row lock for that — see the `hook_disposed` and `hook_received`
      // branches below.
      if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
        const [existingHook] = await drizzle
          .select({ hookId: Schema.hooks.hookId })
          .from(Schema.hooks)
          .where(eq(Schema.hooks.hookId, data.correlationId))
          .limit(1);
        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
        }
      }
      // ============================================================
      // Entity creation/updates based on event type
      // ============================================================
      // Handle run_created event: create the run entity atomically. Its event
      // is written here too, inside the same transaction, so the generic
      // insert below is skipped for it.
      let runCreatedValue;
      if (data.eventType === "run_created") {
        const eventData = data.eventData;
        validateAttributeChanges(
          Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
          {
            allowReservedAttributes: eventData.allowReservedAttributes === true,
          },
        );
        const created = await insertRunWithCreatedEvent(
          drizzle,
          {
            runId: effectiveRunId,
            deploymentId: eventData.deploymentId,
            workflowName: eventData.workflowName,
            // Propagate specVersion from the event to the run entity
            specVersion: effectiveSpecVersion,
            input: eventData.input,
            executionContext: eventData.executionContext,
            attributes: eventData.attributes,
            encryptionPublicKey: eventData.encryptionPublicKey,
            status: "pending",
          },
          {
            correlationId: data.correlationId,
            eventData,
            specVersion: effectiveSpecVersion,
          },
        );
        // No row back means the run already exists: the resilient start path
        // (run_started on a non-existent run) won a TOCTOU race and created
        // it. Surface the conflict rather than returning `{ run: undefined }`
        // — start() already treats EntityConflictError as benign, and falling
        // through would append a duplicate run_created event to the log.
        if (!created) {
          throw new EntityConflictError(
            `Workflow run "${effectiveRunId}" already exists`,
          );
        }
        eventId = created.event.eventId;
        runCreatedValue = { createdAt: created.event.createdAt };
        run = deserializeRunError(compact(created.runValue));
      }
      // Handle run_started event: update run status
      if (data.eventType === "run_started") {
        // If the run is already running, return it without inserting a
        // duplicate run_started event.  This makes run_started idempotent
        // for concurrent invocations: replay is deterministic, so letting
        // multiple callers proceed with the same run is safe.  We skip
        // preloaded events here because this is a rare race-condition path
        // — the runtime falls back to loadWorkflowRunEvents().
        if (currentRun?.status === "running") {
          const [fullRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);
          if (fullRun) {
            return { run: deserializeRunError(compact(fullRun)) };
          }
        }
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: "running",
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(Schema.runs.runId, effectiveRunId))
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        }
      }
      // Handle run_completed event: update run status
      // Uses conditional UPDATE to prevent completing an already-terminal run.
      if (data.eventType === "run_completed") {
        const eventData = data.eventData;
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: "completed",
            output: eventData.output,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES),
            ),
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
        }
      }
      // Handle run_failed event: update run status
      // Uses conditional UPDATE to prevent failing an already-terminal run.
      if (data.eventType === "run_failed") {
        const eventData = data.eventData;
        // The error field is SerializedData (Uint8Array) produced by
        // dehydrateRunError. We store it verbatim in the error_cbor column;
        // consumers hydrate via hydrateRunError.
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: "failed",
            error: eventData.error,
            errorCode: eventData.errorCode,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES),
            ),
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
        }
      }
      // Handle run_cancelled event: update run status
      // Uses conditional UPDATE to prevent cancelling an already-terminal run.
      // Note: idempotent run_cancelled on already-cancelled runs is handled
      // earlier in the pre-validation block (creates event and returns early).
      if (data.eventType === "run_cancelled") {
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: "cancelled",
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES),
            ),
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
        }
      }
      if (isTerminalRunEventType(data.eventType)) {
        // Retained Hooks remain visible after the run ends. Other Hooks and
        // all waits are removed immediately.
        await Promise.all([
          drizzle
            .delete(Schema.hooks)
            .where(
              and(eq(Schema.hooks.runId, effectiveRunId), hookRetentionEnded),
            ),
          drizzle
            .delete(Schema.waits)
            .where(eq(Schema.waits.runId, effectiveRunId)),
        ]);
      }
      if (data.eventType === "attr_set") {
        const { changes, allowReservedAttributes } = data.eventData;
        // Dedup pre-check for correlated workflow writes: if the event is
        // already in the log (a redelivered/replayed duplicate), reject
        // BEFORE materializing onto the run. Without this, a duplicate —
        // including a pathological one carrying different changes for the
        // same correlationId — would mutate `run.attributes` and then fail
        // the event insert, leaving the snapshot out of sync with the
        // event log. The unique index on the insert below still guards the
        // truly-concurrent race; both writers of that race carry identical
        // changes (deterministic replay), so the double-applied update is
        // idempotent there.
        if (data.correlationId && data.eventData.writer.type === "workflow") {
          const [duplicate] = await drizzle
            .select({ eventId: events.eventId })
            .from(events)
            .where(
              and(
                eq(events.runId, effectiveRunId),
                eq(events.correlationId, data.correlationId),
                eq(events.eventType, "attr_set"),
              ),
            )
            .limit(1);
          if (duplicate) {
            throw new EntityConflictError(
              `attr_set for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
            );
          }
        }
        const [existing] = await drizzle
          .select({ attributes: Schema.runs.attributes })
          .from(Schema.runs)
          .where(eq(Schema.runs.runId, effectiveRunId))
          .limit(1);
        if (!existing) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(existing.attributes ?? {}),
          allowReservedAttributes: allowReservedAttributes === true,
        });
        let expr = sql`COALESCE(${Schema.runs.attributes}, '{}'::jsonb)`;
        for (const { key, value } of changes) {
          if (value === null) {
            expr = sql`${expr} - ${key}`;
          } else {
            expr = sql`jsonb_set(${expr}, ARRAY[${key}]::text[], to_jsonb(${value}::text), true)`;
          }
        }
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            attributes: expr,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              sql`(SELECT COUNT(*) FROM jsonb_object_keys(${expr})) <= ${ATTRIBUTE_MAX_PER_RUN}`,
            ),
          )
          .returning();
        if (!runValue) {
          // The guarded update matches zero rows either because the cap
          // condition failed or because the run row disappeared between the
          // existence check above and this update — distinguish the two so
          // the error is not misattributed.
          const [stillExists] = await drizzle
            .select({ runId: Schema.runs.runId })
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);
          if (!stillExists) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          throw new AttributeValidationError(
            `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN}`,
          );
        }
        run = deserializeRunError(compact(runValue));
      }
      // Strip eventData from run_started — it belongs on run_created only.
      // For step_started on the lazy-start path, strip only the step `input`
      // (it belongs on the synthetic step_created written below); `stepName`
      // is preserved for the client replay consumer's step-name divergence
      // check.
      let storedEventData;
      if (data.eventType === "run_started") {
        storedEventData = undefined;
      } else if ("eventData" in data && data.eventData) {
        if (data.eventType === "step_started" && "input" in data.eventData) {
          const { input: _strippedInput, ...rest } = data.eventData;
          storedEventData = rest;
        } else {
          storedEventData = data.eventData;
        }
      } else {
        storedEventData = undefined;
      }
      // Handle step_created event: create step entity
      if (data.eventType === "step_created") {
        const eventData = data.eventData;
        // Osinara fork: the input stays in the step_created event only (see
        // `attachStepPayloads`); the row carries the step's state.
        const [stepValue] = await drizzle
          .insert(Schema.steps)
          .values({
            runId: effectiveRunId,
            stepId: data.correlationId,
            stepName: eventData.stepName,
            status: "pending",
            attempt: 0,
            // Propagate specVersion from the event to the step entity
            specVersion: effectiveSpecVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact({ ...stepValue, input: eventData.input }));
        }
      }
      let value = runCreatedValue;
      // Handle step_started event: increment attempt and set the step to
      // running, then write the matching event log entry in the same
      // transaction. The guarded UPDATE takes the step row lock; keeping the
      // event INSERT behind that lock prevents a late step_started from being
      // ordered after a concurrent terminal event that already won the row.
      if (data.eventType === "step_started") {
        value = await drizzle.transaction(async (tx) => {
          // Lazy step start: no prior step_created exists, but this
          // step_started carries the step-creation data. The step INSERT is
          // the ownership claim: only the caller that inserts the row gets to
          // run the step body inline.
          if (lazyStepStart && !validatedStep) {
            const lazyData = data.eventData;
            const [inserted] = await tx
              .insert(Schema.steps)
              .values({
                runId: effectiveRunId,
                stepId: data.correlationId,
                stepName: lazyData.stepName,
                // The input goes into the synthetic step_created event below.
                status: "pending",
                attempt: 0,
                specVersion: effectiveSpecVersion,
              })
              .onConflictDoNothing()
              .returning({ stepId: Schema.steps.stepId });
            if (!inserted) {
              throw new EntityConflictError(
                `Step "${data.correlationId}" already created`,
              );
            }
            // Replay still needs to observe step_created before
            // step_started. Because this synthetic event is in the same
            // transaction as the lazy step row and step_started event, we
            // cannot leave behind only one side of that materialization.
            try {
              await insertEventRow(tx, {
                runId: effectiveRunId,
                eventId: await allocateEventId(tx, effectiveRunId),
                correlationId: data.correlationId,
                eventType: "step_created",
                eventData: {
                  stepName: lazyData.stepName,
                  input: lazyData.input,
                },
                specVersion: effectiveSpecVersion,
              });
            } catch (err) {
              // A concurrent writer already published this run's
              // step_created for the same step. The event exists either way,
              // which is all this synthetic write was for.
              if (
                pgErrorOf(err).constraint !==
                "workflow_events_entity_creation_unique"
              ) {
                throw err;
              }
            }
            stepCreatedLazily = true;
          }
          // Retried steps may be scheduled for later. Keep this check inside
          // the transaction so the step_started write cannot slip past it.
          if (
            validatedStep?.retryAfter &&
            validatedStep.retryAfter.getTime() > Date.now()
          ) {
            throw new TooEarlyError(
              `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil(
                  (validatedStep.retryAfter.getTime() - Date.now()) / 1000,
                ),
              },
            );
          }
          // The terminal-state guard is part of the UPDATE, not just the
          // earlier validation read. That closes the race where another
          // writer completes/fails the step between validation and start.
          const [stepValue] = await tx
            .update(Schema.steps)
            .set({
              status: "running",
              attempt: sql`${Schema.steps.attempt} + 1`,
              // Preserve the original first-start timestamp across retries or
              // overlapping starts.
              startedAt: sql`COALESCE(${Schema.steps.startedAt}, ${now.toISOString()})`,
              retryAfter: null,
            })
            .where(
              and(
                eq(Schema.steps.runId, effectiveRunId),
                eq(Schema.steps.stepId, data.correlationId),
                notInArray(Schema.steps.status, terminalStepStatuses),
              ),
            )
            .returning();
          if (stepValue) {
            // The runtime runs a queued step from the entity reported here,
            // so the input comes back with it: from the lazy start in hand,
            // otherwise from the step_created event (the row no longer has it).
            const input = stepValue.input ??
              (lazyStepStart && !validatedStep
                ? data.eventData.input
                : await stepInputFromEvent(tx, effectiveRunId, data.correlationId));
            step = deserializeStepError(compact({ ...stepValue, input }));
          } else {
            const [existing] = await tx
              .select({ status: Schema.steps.status })
              .from(Schema.steps)
              .where(
                and(
                  eq(Schema.steps.runId, effectiveRunId),
                  eq(Schema.steps.stepId, data.correlationId),
                ),
              )
              .limit(1);
            if (!existing) {
              throw new WorkflowWorldError(
                `Step "${data.correlationId}" not found`,
              );
            }
            if (isTerminalStepStatus(existing.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${existing.status}"`,
              );
            }
          }
          // Allocate the step_started position only after the guarded step
          // UPDATE has acquired and passed the row lock, so a writer blocked
          // on the step row cannot carry an earlier position into a later
          // insert.
          const eventValue = await insertEventRow(tx, {
            runId: effectiveRunId,
            eventId: await allocateEventId(tx, effectiveRunId),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            specVersion: effectiveSpecVersion,
          });
          if (!eventValue) {
            throw new EntityConflictError(
              `Event for step "${data.correlationId}" could not be created`,
            );
          }
          eventId = eventValue.eventId;
          return { createdAt: eventValue.createdAt };
        }, SLOT_INSERT_TRANSACTION);
      }
      // Handle step_completed event: update step status
      // Uses conditional UPDATE to prevent completing an already-terminal step.
      if (data.eventType === "step_completed") {
        const eventData = data.eventData;
        // Osinara fork: the result stays in the step_completed event only.
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: "completed",
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId),
              notInArray(Schema.steps.status, terminalStepStatuses),
            ),
          )
          .returning();
        if (stepValue) {
          // The entity reported back carries the result it was just given.
          step = deserializeStepError(compact({ ...stepValue, output: eventData.result }));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`,
            );
          }
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
        }
      }
      // Handle step_failed event: terminal state with error
      // Uses conditional UPDATE to prevent failing an already-terminal step.
      if (data.eventType === "step_failed") {
        const eventData = data.eventData;
        // The error field is SerializedData (Uint8Array) produced by
        // dehydrateStepError. We store it verbatim in the error_cbor column;
        // consumers hydrate via hydrateStepError.
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: "failed",
            error: eventData.error,
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId),
              notInArray(Schema.steps.status, terminalStepStatuses),
            ),
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`,
            );
          }
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
        }
      }
      // Handle step_retrying event: sets status back to 'pending', records error
      // Uses conditional UPDATE to prevent retrying an already-terminal step.
      if (data.eventType === "step_retrying") {
        const eventData = data.eventData;
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: "pending",
            error: eventData.error,
            retryAfter: eventData.retryAfter,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId),
              notInArray(Schema.steps.status, terminalStepStatuses),
            ),
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`,
            );
          }
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
        }
      }
      // Handle hook_created event: create hook entity
      // Uses prepared statement for token uniqueness check (performance optimization)
      if (data.eventType === "hook_created") {
        const { eventData } = data;
        // Check for duplicate token using prepared statement
        const [existingHook] = await getHookByToken.execute({
          token: eventData.token,
        });
        if (existingHook) {
          // Idempotency: if the existing hook is the *same* (runId, hookId)
          // we are trying to create, this is either a duplicate / replayed
          // processing of the same hook_created (not a real conflict), or
          // an orphaned hook row from a prior crashed attempt (the hook
          // INSERT below landed but the events INSERT below didn't —
          // these writes are not in one transaction). Distinguish by
          // checking whether the `hook_created` event actually exists in
          // the event log:
          //   - exists → real duplicate: throw EntityConflictError so the
          //     runtime's concurrent-replay catch path (matching the
          //     step_created path) swallows it, instead of producing a
          //     self-conflict in the event log that would later replay
          //     as HookConflictError.
          //     See https://github.com/vercel/workflow/issues/2283.
          //   - missing → orphaned hook row (crash between hook INSERT
          //     and events INSERT): skip the hook insert (the existing
          //     row already has the desired state) and fall through to
          //     the events INSERT below, completing the partial write.
          if (
            existingHook.runId === effectiveRunId &&
            existingHook.hookId === data.correlationId
          ) {
            const [existingEvent] = await getHookCreatedEvent.execute({
              runId: effectiveRunId,
              correlationId: data.correlationId,
              eventType: "hook_created",
            });
            if (existingEvent) {
              throw new EntityConflictError(
                `Hook "${data.correlationId}" already created`,
              );
            }
            // Orphaned hook row: hook row exists but no hook_created
            // event in the log. Skip the hook insert below (the row
            // already exists with our (runId, hookId)) and let the
            // outer code path emit the hook_created event, completing
            // the partial write. We also re-fetch the existing hook
            // row so the EventResult carries the actual persisted
            // entity rather than `undefined`.
            const [recoveredHookValue] = await drizzle
              .select()
              .from(Schema.hooks)
              .where(eq(Schema.hooks.hookId, data.correlationId))
              .limit(1);
            if (recoveredHookValue) {
              recoveredHookValue.metadata ||= recoveredHookValue.metadataJson;
              hook = HookSchema.parse(compact(recoveredHookValue));
            }
          } else {
            // Cross-hook / cross-run conflict: a different
            // (runId, hookId) holds this token. Create a hook_conflict
            // event instead of throwing 409 — this lets the workflow
            // continue and fail gracefully when the hook is awaited.
            const conflictEventData = {
              token: eventData.token,
              conflictingRunId: existingHook.runId,
            };
            const conflictValue = await insertEventRow(drizzle, {
              runId: effectiveRunId,
              eventId: await getEventId(),
              correlationId: data.correlationId,
              eventType: "hook_conflict",
              eventData: conflictEventData,
              specVersion: effectiveSpecVersion,
            });
            if (!conflictValue) {
              throw new EntityConflictError(
                `hook_conflict for run "${effectiveRunId}" could not be created`,
              );
            }
            const conflictEventId = conflictValue.eventId;
            eventId = conflictEventId;
            const conflictResult = {
              eventType: "hook_conflict",
              correlationId: data.correlationId,
              eventData: conflictEventData,
              ...conflictValue,
              runId: effectiveRunId,
              eventId: conflictEventId,
            };
            const parsedConflict = EventSchema.parse(conflictResult);
            const resolveData = params?.resolveData ?? "all";
            return {
              event: stripEventDataRefs(parsedConflict, resolveData),
              run,
              step,
              hook: undefined,
            };
          }
        } else {
          await drizzle
            .delete(Schema.hooks)
            .where(
              and(
                eq(Schema.hooks.token, eventData.token),
                exists(ownerRunIsTerminal),
                hookRetentionEnded,
              ),
            );
          const [hookValue] = await drizzle
            .insert(Schema.hooks)
            .values({
              runId: effectiveRunId,
              hookId: data.correlationId,
              token: eventData.token,
              metadata: eventData.metadata,
              ownerId: "", // TODO: get from context
              projectId: "", // TODO: get from context
              environment: "", // TODO: get from context
              tokenRetentionUntil: eventData.tokenRetentionUntil,
              // Propagate specVersion from the event to the hook entity
              specVersion: effectiveSpecVersion,
              isWebhook: eventData.isWebhook,
              isSystem: eventData.isSystem ?? false,
            })
            .onConflictDoNothing()
            .returning();
          if (hookValue) {
            hookValue.metadata ||= hookValue.metadataJson;
            hook = HookSchema.parse(compact(hookValue));
          }
        }
      }
      // Handle hook_disposed event: delete the hook entity and append the
      // disposal in ONE transaction.
      //
      // `DELETE ... RETURNING` ensures only one concurrent caller succeeds — if
      // no rows are returned, the hook was already disposed. The delete also
      // takes the hook row's lock, and the transaction is what holds it until
      // the `hook_disposed` row exists. Committed separately (as this used to
      // be), the lock is released at the delete's own autocommit, which leaves a
      // window for a resume to pass its existence check and land its
      // `hook_received` AFTER this disposal. That order is durable, and it
      // corrupts the owning run for good: no replay can consume a delivery
      // behind the disposal that retired the hook's consumer, so it strands,
      // every replay reports divergence and the run ends in
      // CorruptedEventLogError. See vercel/workflow#2781, which fixed the same
      // ordering for world-local.
      if (data.eventType === "hook_disposed" && data.correlationId) {
        const disposedHookId = data.correlationId;
        value = await drizzle.transaction(async (tx) => {
          const [deleted] = await tx
            .delete(Schema.hooks)
            .where(eq(Schema.hooks.hookId, disposedHookId))
            .returning({ hookId: Schema.hooks.hookId });
          if (!deleted) {
            throw new EntityConflictError(
              `Hook "${disposedHookId}" already disposed`,
            );
          }
          // Allocated only after the lock is held, matching hook_received's
          // ordering guarantee: a writer that had to wait must not carry an
          // earlier position into a later insert.
          const eventValue = await insertEventRow(tx, {
            runId: effectiveRunId,
            eventId: await getEventId(tx),
            correlationId: disposedHookId,
            eventType: data.eventType,
            eventData: storedEventData,
            specVersion: effectiveSpecVersion,
          });
          if (!eventValue) {
            throw new EntityConflictError(
              `Event for hook "${disposedHookId}" could not be created`,
            );
          }
          eventId = eventValue.eventId;
          return { createdAt: eventValue.createdAt };
        }, SLOT_INSERT_TRANSACTION);
      }
      // Handle hook_received event: append the event only if the run has
      // not reached a terminal state. hook_received has no branch in the
      // terminal-run guard above (it doesn't transition the run or create
      // an entity), so without this, the generic INSERT further below
      // could append a hook_received event after a concurrent
      // run_completed / run_failed / run_cancelled has already committed.
      // `FOR UPDATE` takes the run row lock inside this transaction: it
      // blocks until any in-flight terminal transition — whose own
      // conditional UPDATE takes the same row lock — commits, then
      // observes the post-commit status. That linearizes this insert
      // against the run's terminal transition the same way step_started's
      // guarded UPDATE linearizes against a concurrent terminal step
      // event.
      if (data.eventType === "hook_received") {
        value = await drizzle.transaction(async (tx) => {
          const [runRow] = await tx
            .select({ status: Schema.runs.status })
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .for("update")
            .limit(1);
          if (!runRow) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(runRow.status)) {
            throw new RunExpiredError(
              `Workflow run "${effectiveRunId}" is already in terminal state "${runRow.status}"`,
            );
          }
          // Re-check the hook under its own row lock, for the ordering the
          // unlocked read near the top of `create` cannot settle. `FOR UPDATE`
          // blocks on the disposer's `DELETE`, which holds that lock until its
          // `hook_disposed` row is committed, then re-evaluates: either this
          // delivery got the lock first and its `hook_received` is ordered
          // BEFORE the disposal, or the disposer got it and the row is gone and
          // this delivery is refused. The one order that is unreachable is the
          // one that corrupts the run — a `hook_received` journaled behind its
          // hook's `hook_disposed`, which no replay can consume.
          //
          // Under READ COMMITTED (see SLOT_INSERT_TRANSACTION) a locked read of
          // a row deleted by the transaction it waited on returns no row rather
          // than raising, so the refusal needs no serialization-failure
          // handling. Reported as HookNotFoundError, matching the unlocked
          // check and the public resume contract for a hook that can no longer
          // receive.
          if (data.correlationId) {
            const [liveHook] = await tx
              .select({ hookId: Schema.hooks.hookId })
              .from(Schema.hooks)
              .where(eq(Schema.hooks.hookId, data.correlationId))
              .for("update")
              .limit(1);
            if (!liveHook) {
              throw new HookNotFoundError(data.correlationId);
            }
          }
          // Allocate the position only after the row locks are acquired,
          // matching step_started's ordering guarantee: a writer blocked
          // on a lock must not carry an earlier position into a later
          // insert.
          const eventValue = await insertEventRow(tx, {
            runId: effectiveRunId,
            eventId: await allocateEventId(tx, effectiveRunId),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            specVersion: effectiveSpecVersion,
          });
          if (!eventValue) {
            throw new EntityConflictError(
              `Event for hook "${data.correlationId}" could not be created`,
            );
          }
          eventId = eventValue.eventId;
          return { createdAt: eventValue.createdAt };
        }, SLOT_INSERT_TRANSACTION);
      }
      // Handle wait_created event: create wait entity
      if (data.eventType === "wait_created") {
        const eventData = data.eventData;
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        const [waitValue] = await drizzle
          .insert(Schema.waits)
          .values({
            waitId,
            runId: effectiveRunId,
            status: "waiting",
            resumeAt: eventData.resumeAt,
            specVersion: effectiveSpecVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (waitValue) {
          wait = {
            waitId: waitValue.waitId,
            runId: waitValue.runId,
            status: waitValue.status,
            resumeAt: waitValue.resumeAt ?? undefined,
            completedAt: waitValue.completedAt ?? undefined,
            createdAt: waitValue.createdAt,
            updatedAt: waitValue.updatedAt,
            specVersion: waitValue.specVersion ?? undefined,
          };
        } else {
          throw new EntityConflictError(
            `Wait "${data.correlationId}" already exists`,
          );
        }
      }
      // Handle wait_completed event: transition wait to 'completed'
      // Uses conditional UPDATE to reject duplicate completions (same pattern as step_completed)
      if (data.eventType === "wait_completed") {
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        const [waitValue] = await drizzle
          .update(Schema.waits)
          .set({
            status: "completed",
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.waits.waitId, waitId),
              eq(Schema.waits.status, "waiting"),
            ),
          )
          .returning();
        if (waitValue) {
          wait = {
            waitId: waitValue.waitId,
            runId: waitValue.runId,
            status: waitValue.status,
            resumeAt: waitValue.resumeAt ?? undefined,
            completedAt: waitValue.completedAt ?? undefined,
            createdAt: waitValue.createdAt,
            updatedAt: waitValue.updatedAt,
            specVersion: waitValue.specVersion ?? undefined,
          };
        } else {
          // Wait not updated - check if it exists and why
          const [existing] = await getWaitForValidation.execute({
            waitId,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Wait "${data.correlationId}" not found`,
            );
          }
          if (existing.status === "completed") {
            throw new EntityConflictError(
              `Wait "${data.correlationId}" already completed`,
            );
          }
        }
      }
      try {
        if (!value) {
          const inserted = await insertEventRow(drizzle, {
            runId: effectiveRunId,
            eventId: await getEventId(),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            specVersion: effectiveSpecVersion,
          });
          if (inserted) {
            eventId = inserted.eventId;
            value = { createdAt: inserted.createdAt };
          }
        }
      } catch (err) {
        // Translate unique-violation on the correlated-event partial index
        // (workflow_events_entity_creation_unique) into EntityConflictError
        // so the runtime's existing dedup catch path can handle it. Without
        // this, two concurrent invocations producing identical
        // correlationIds (e.g. snapshot runtime deterministic ULIDs) would
        // surface as unhandled DB errors instead of dedup signals.
        // Drizzle wraps the underlying pg error in DrizzleQueryError; the
        // pg error (with .code === '23505') lives on .cause. We additionally
        // gate on the violated constraint name so other 23505 violations on
        // these event types (e.g. the events primary key, or any future
        // unique constraint we might add) don't get misclassified as a
        // correlationId conflict.
        const isDeduplicatedCorrelatedEvent =
          isChildEntityCreationEventType(data.eventType) ||
          (data.eventType === "attr_set" &&
            data.eventData.writer.type === "workflow");
        const pgErr = pgErrorOf(err);
        const pgCode = pgErr.code;
        const pgConstraint = pgErr.constraint;
        if (
          isDeduplicatedCorrelatedEvent &&
          pgCode === "23505" &&
          pgConstraint === "workflow_events_entity_creation_unique"
        ) {
          throw new EntityConflictError(
            `${data.eventType} for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
          );
        }
        throw err;
      }
      if (!value || !eventId) {
        throw new EntityConflictError(
          `${data.eventType} for run "${effectiveRunId}" could not be created`,
        );
      }
      const result = {
        ...data,
        ...value,
        runId: effectiveRunId,
        eventId,
        ...(storedEventData !== undefined
          ? { eventData: storedEventData }
          : {}),
      };
      // Strip eventData leaked by ...data spread for run_started events.
      // The eventData (run input for resilient start) belongs on
      // run_created only; storedEventData is already undefined above.
      if (data.eventType === "run_started") {
        delete result.eventData;
      }
      const parsed = EventSchema.parse(result);
      const resolveData = params?.resolveData ?? "all";
      // For run_started: include all events so the runtime can skip
      // the initial events.list call and reduce TTFB.
      let eventPage;
      // The skipped-slot report and the inline delta below share
      // `events`/`cursor`/`hasMore`, and the runtime sends both on the same
      // write. The delta wins: the skipped slots all sit above the cursor, so
      // it is a strict superset, and it is the only one of the two that
      // advances `cursor`. Running the report anyway would cost a query whose
      // result the delta overwrites.
      if (
        params?.eventCount !== undefined &&
        typeof params.sinceCursor !== "string"
      ) {
        const report = await reportSkippedSlots(
          drizzle,
          effectiveRunId,
          parsed.eventId,
          params.eventCount,
          resolveData,
        );
        if (report) {
          // Deliberately no cursor: the report is a lower bound on what this
          // write skipped over, not a page the caller has now read to the end
          // of, so it must not advance the caller's read position.
          eventPage = {
            data: report.events,
            cursor: null,
            hasMore: report.hasMore,
          };
        }
      }
      if (data.eventType === "run_started" && run && !params?.skipPreload) {
        const eventRows = await drizzle
          .select()
          .from(Schema.events)
          .where(eq(Schema.events.runId, effectiveRunId))
          .orderBy(Schema.events.eventId);
        const data = eventRows.map((e) => {
          e.eventData ||= e.eventDataJson;
          const parsed = EventSchema.parse(compact(e));
          return stripEventDataRefs(parsed, resolveData);
        });
        eventPage = {
          data,
          cursor: data.at(-1)?.eventId ?? null,
          hasMore: false,
        };
      }
      // Inline delta: the caller told us the cursor of the log it holds, so
      // return the page `events.list({ cursor: sinceCursor, sortOrder: 'asc' })`
      // would return right now and save it the round-trip. Same query, same
      // page size, same cursor semantics as `list` below — deliberately not
      // paginated to exhaustion, since the contract is
      // single-page-or-fall-back and the caller ignores a delta with
      // `hasMore: true`.
      if (typeof params?.sinceCursor === "string") {
        const limit = 100;
        const deltaRows = await drizzle
          .select()
          .from(Schema.events)
          .where(
            and(
              eq(Schema.events.runId, effectiveRunId),
              gt(Schema.events.eventId, params.sinceCursor),
            ),
          )
          .orderBy(Schema.events.eventId)
          .limit(limit + 1);
        const page = deltaRows.slice(0, limit);
        const data = page.map((e) => {
          e.eventData ||= e.eventDataJson;
          return stripEventDataRefs(EventSchema.parse(compact(e)), resolveData);
        });
        eventPage = {
          data,
          cursor: data.at(-1)?.eventId ?? null,
          hasMore: deltaRows.length > limit,
        };
      }
      const eventResult = {
        event: stripEventDataRefs(parsed, resolveData),
        run,
        step,
        hook,
        wait,
        ...(stepCreatedLazily ? { stepCreated: true } : {}),
      };
      if (!eventPage) return eventResult;
      return {
        ...eventResult,
        events: eventPage.data,
        cursor: eventPage.cursor,
        hasMore: eventPage.hasMore,
      };
    },
    async get(runId, eventId, params) {
      const [value] = await drizzle
        .select()
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.eventId, eventId)))
        .limit(1);
      if (!value) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`);
      }
      value.eventData ||= value.eventDataJson;
      const parsed = EventSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? "all";
      return stripEventDataRefs(parsed, resolveData);
    },
    async list(params) {
      const limit = params.pagination?.limit ?? getMaxEventsPerRun();
      const sortOrder = params.pagination?.sortOrder ?? "asc";
      const order =
        sortOrder === "desc"
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const resolveData = params.resolveData ?? "all";
      // Resuming a run lists its whole log with no payloads. The log only grows, so a run
      // already read in this process is compared by row count and extended by its tail.
      const readStartedAt = performance.now();
      const cacheKey = eventLogCacheKey(params, resolveData, sortOrder);
      let cached = cacheKey === null ? undefined : readEventLogCache(cacheKey);
      if (cacheKey !== null && cached !== undefined) {
        if (cached.data.length >= limit) {
          cached = undefined;
        } else {
          const [counted] = await drizzle
            .select({ total: sql`count(*)` })
            .from(events)
            .where(eq(events.runId, params.runId));
          const total = Number(counted?.total ?? 0);
          if (total < cached.data.length) {
            dropEventLogCache(cacheKey);
            cached = undefined;
          } else if (total === cached.data.length) {
            traceEventLogRead(
              params.runId,
              total,
              0,
              performance.now() - readStartedAt,
            );
            return {
              data: [...cached.data],
              cursor: cached.cursor ?? null,
              hasMore: false,
            };
          }
        }
      }
      const data = cached === undefined ? [] : [...cached.data];
      const reusedEvents = data.length;
      let cursor =
        cached === undefined ? params.pagination?.cursor : cached.cursor;
      let hasMore = false;
      do {
        const pageLimit =
          params.pagination?.limit === undefined
            ? Math.min(500, limit - data.length)
            : limit;
        const rows = await drizzle
          .select()
          .from(events)
          .where(
            and(
              eq(events.runId, params.runId),
              map(cursor, (value) => order.compare(events.eventId, value)),
            ),
          )
          .orderBy(order.by)
          .limit(pageLimit + 1);
        const page = rows.slice(0, pageLimit);
        for (const row of page) {
          row.eventData ||= row.eventDataJson;
          const event = EventSchema.parse(compact(row));
          data.push(stripEventDataRefs(event, resolveData));
        }
        cursor = page.at(-1)?.eventId;
        hasMore = rows.length > pageLimit;
      } while (
        params.pagination?.limit === undefined &&
        hasMore &&
        data.length < limit
      );
      // Only a listing that reached the end of the log may be reused as a prefix.
      if (cacheKey !== null) {
        traceEventLogRead(
          params.runId,
          reusedEvents,
          data.length - reusedEvents,
          performance.now() - readStartedAt,
        );
        if (!hasMore) writeEventLogCache(cacheKey, data, data.at(-1)?.eventId);
      }
      return {
        data,
        cursor: data.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || "asc";
      const order =
        sortOrder === "desc"
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            // A correlation id names a step or wait within its run, so an
            // unscoped query matches one event per run that allocated the same
            // id — and the cursor, an event id, cannot tell two such rows
            // apart. Scoped, `(run_id, id)` is the primary key, so it can.
            eq(events.runId, params.runId),
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c),
            ),
          ),
        )
        .orderBy(order.by)
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const resolveData = params?.resolveData ?? "all";
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return stripEventDataRefs(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
  };
}
export function createHooksStorage(drizzle) {
  const { hooks, runs } = Schema;
  const ownerRunIsTerminal = drizzle
    .select({ runId: runs.runId })
    .from(runs)
    .where(
      and(
        eq(runs.runId, hooks.runId),
        inArray(runs.status, TERMINAL_WORKFLOW_RUN_STATUSES),
      ),
    );
  const available = or(
    gt(hooks.tokenRetentionUntil, sql`now()`),
    notExists(ownerRunIsTerminal),
  );
  const getByToken = drizzle
    .select()
    .from(hooks)
    .where(and(eq(hooks.token, sql.placeholder("token")), available))
    .limit(1)
    .prepare("workflow_hooks_get_by_token");
  return {
    async get(hookId, params) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(and(eq(hooks.hookId, hookId), available))
        .limit(1);
      if (!value) {
        throw new HookNotFoundError(hookId);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? "all";
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new HookNotFoundError(token);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? "all";
      return filterHookData(parsed, resolveData);
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;
      const sortOrder = params?.pagination?.sortOrder ?? "asc";
      const orderFn = sortOrder === "asc" ? asc : desc;
      const cursorFn = sortOrder === "asc" ? gt : lt;
      const all = await drizzle
        .select()
        .from(hooks)
        .where(
          and(
            available,
            map(params.runId, (id) => eq(hooks.runId, id)),
            map(fromCursor, (c) => cursorFn(hooks.hookId, c)),
          ),
        )
        .orderBy(orderFn(hooks.hookId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;
      const resolveData = params?.resolveData ?? "all";
      return {
        data: values.map((v) => {
          v.metadata ||= v.metadataJson;
          const parsed = HookSchema.parse(compact(v));
          return filterHookData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
  };
}
/**
 * Fills the input and output of step rows from their step_created and
 * step_completed events.
 *
 * Osinara fork (3 October 2026). Upstream wrote every step's input and
 * output twice: into the event and into the step row, so a load run's
 * database was 1.6 GB of events plus 1.0 GB of steps holding the same bytes.
 * Replay reads a result from its step_completed event and the runtime keeps
 * the input it dispatched, so the row now carries the step's state only and
 * the payload is read back here for the one API that returns whole steps.
 * A row written before the change still has its columns and is left alone.
 */
async function stepInputFromEvent(db, runId, stepId) {
  const { events } = Schema;
  const [created] = await db
    .select({ eventData: events.eventData })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        eq(events.correlationId, stepId),
        eq(events.eventType, "step_created"),
      ),
    )
    .limit(1);
  return created?.eventData?.input;
}
async function attachStepPayloads(db, runId, rows) {
  const missing = rows.filter((row) => row.input == null || row.output == null);
  if (missing.length === 0) return;
  const { events } = Schema;
  const payloads = await db
    .select({
      correlationId: events.correlationId,
      eventData: events.eventData,
      eventType: events.eventType,
    })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        inArray(events.correlationId, missing.map((row) => row.stepId)),
        inArray(events.eventType, ["step_created", "step_completed"]),
      ),
    )
    .orderBy(asc(events.eventId));
  for (const row of missing) {
    for (const event of payloads) {
      if (event.correlationId !== row.stepId) continue;
      if (event.eventType === "step_created" && row.input == null) {
        row.input = event.eventData?.input;
      } else if (event.eventType === "step_completed" && row.output == null) {
        row.output = event.eventData?.result;
      }
    }
  }
}
export function createStepsStorage(drizzle) {
  const { steps } = Schema;
  return {
    get: async (runId, stepId, params) => {
      const [value] = await drizzle
        .select()
        .from(steps)
        .where(and(eq(steps.runId, runId), eq(steps.stepId, stepId)))
        .limit(1);
      if (!value) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`);
      }
      value.output ||= value.outputJson;
      value.input ||= value.inputJson;
      value.error ||= parseErrorJson(value.errorJson);
      const resolveData = params?.resolveData ?? "all";
      if (resolveData !== "none") await attachStepPayloads(drizzle, runId, [value]);
      const deserialized = deserializeStepError(compact(value));
      const parsed = StepSchema.parse(deserialized);
      return filterStepData(parsed, resolveData);
    },
    list: async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;
      const all = await drizzle
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, params.runId),
            map(fromCursor, (c) => lt(steps.stepId, c)),
          ),
        )
        .orderBy(desc(steps.stepId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;
      const resolveData = params?.resolveData ?? "all";
      if (resolveData !== "none") await attachStepPayloads(drizzle, params.runId, values);
      return {
        data: values.map((v) => {
          v.output ||= v.outputJson;
          v.input ||= v.inputJson;
          v.error ||= parseErrorJson(v.errorJson);
          const deserialized = deserializeStepError(compact(v));
          const parsed = StepSchema.parse(deserialized);
          return filterStepData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    },
  };
}
function filterStepData(step, resolveData) {
  if (resolveData === "none") {
    const { input: _, output: __, ...rest } = step;
    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}
function filterRunData(run, resolveData) {
  if (resolveData === "none") {
    const { input: _, output: __, ...rest } = run;
    return { input: undefined, output: undefined, ...rest };
  }
  return run;
}
function filterHookData(hook, resolveData) {
  if (resolveData === "none" && "metadata" in hook) {
    const { metadata: _, ...rest } = hook;
    return { metadata: undefined, ...rest };
  }
  return hook;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9zdG9yYWdlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFDTCxtQkFBbUIsRUFDbkIsaUJBQWlCLEVBQ2pCLGVBQWUsRUFDZixvQkFBb0IsRUFDcEIsYUFBYSxFQUNiLHdCQUF3QixFQUN4QixrQkFBa0IsR0FDbkIsTUFBTSxrQkFBa0IsQ0FBQztBQXNCMUIsT0FBTyxFQUNMLHFCQUFxQixFQUNyQix3QkFBd0IsRUFDeEIsb0JBQW9CLEVBQ3BCLGVBQWUsRUFDZixXQUFXLEVBQ1gsYUFBYSxFQUNiLGdCQUFnQixFQUNoQixrQkFBa0IsRUFDbEIsVUFBVSxFQUNWLDBCQUEwQixFQUMxQiw4QkFBOEIsRUFDOUIsNkJBQTZCLEVBQzdCLG1CQUFtQixFQUNuQixzQkFBc0IsRUFDdEIsb0JBQW9CLEVBQ3BCLDJCQUEyQixFQUMzQixrQkFBa0IsRUFDbEIsb0JBQW9CLEVBQ3BCLFVBQVUsRUFDVixhQUFhLEVBQ2Isa0JBQWtCLEVBQ2xCLHNCQUFzQixFQUN0Qiw4QkFBOEIsRUFDOUIsd0JBQXdCLEVBQ3hCLHFCQUFxQixFQUNyQixpQkFBaUIsR0FDbEIsTUFBTSxpQkFBaUIsQ0FBQztBQUN6QixPQUFPLEVBQ0wsR0FBRyxFQUNILEdBQUcsRUFDSCxJQUFJLEVBQ0osRUFBRSxFQUNGLE1BQU0sRUFDTixFQUFFLEVBQ0YsT0FBTyxFQUNQLE1BQU0sRUFDTixFQUFFLEVBQ0YsR0FBRyxFQUNILFNBQVMsRUFDVCxVQUFVLEVBQ1YsRUFBRSxFQUVGLEdBQUcsR0FDSixNQUFNLGFBQWEsQ0FBQztBQUNyQixPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxNQUFNLENBQUM7QUFDeEMsT0FBTyxFQUFnQixNQUFNLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUUxRCxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBRXBDLE1BQU0sTUFBTSxHQUFHLEVBQUUs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QUksRUFBRSxHQUFHLElBQUksQ0FBQztRQUV0QyxPQUFPLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRSxHQUFHLElBQUksRUFBRSxDQUFDO0lBQzFDLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNkLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBFbnRpdHlDb25mbGljdEVycm9yLFxuICBIb29rTm90Rm91bmRFcnJvcixcbiAgUnVuRXhwaXJlZEVycm9yLFxuICBSdW5Ob3RTdXBwb3J0ZWRFcnJvcixcbiAgVG9vRWFybHlFcnJvcixcbiAgV29ya2Zsb3dSdW5Ob3RGb3VuZEVycm9yLFxuICBXb3JrZmxvd1dvcmxkRXJyb3IsXG59IGZyb20gJ0B3b3JrZmxvdy9lcnJvcnMnO1xuaW1wb3J0IHR5cGUge1xuICBBbnlFdmVudFJlcXVlc3QsXG4gIEF0dHJpYnV0ZUNoYW5nZSxcbiAgQ3JlYXRlRXZlbnRQYXJhbXMsXG4gIEV2ZW50LFxuICBFdmVudFJlc3VsdCxcbiAgRXhwZXJpbWVudGFsU2V0QXR0cmlidXRlc1Jlc3VsdCxcbiAgR2V0RXZlbnRQYXJhbXMsXG4gIEhvb2ssXG4gIExpc3RFdmVudHNQYXJhbXMsXG4gIExpc3RIb29rc1BhcmFtcyxcbiAgUGFnaW5hdGVkUmVzcG9uc2UsXG4gIFJlc29sdmVEYXRhLFxuICBTZXJpYWxpemVkRGF0YSxcbiAgU3RlcCxcbiAgU3RlcFdpdGhvdXREYXRhLFxuICBTdG9yYWdlLFxuICBXYWl0LFxuICBXb3JrZmxvd1J1bixcbiAgV29ya2Zsb3dSdW5XaXRob3V0RGF0YSxcbn0gZnJvbSAnQHdvcmtmbG93L3dvcmxkJztcbmltcG9ydCB7XG4gIEFUVFJJQlVURV9NQVhfUEVSX1JVTixcbiAgQXR0cmlidXRlVmFsaWRhdGlvbkVycm9yLFxuICBFVkVOVF9JRF9CT0RZX0xFTkdUSCxcbiAgRVZFTlRfSURfUFJFRklYLFxuICBFdmVudFNjaGVtYSxcbiAgZXZlbnRJZFRvU2xvdCxcbiAgRklSU1RfRVZFTlRfU0xPVCxcbiAgZ2V0TWF4RXZlbnRzUGVyUnVuLFxuICBIb29rU2NoZW1hLFxuICBpc0NoaWxkRW50aXR5Q3JlYXRpb25FdmVudCxcbiAgaXNDaGlsZEVudGl0eUNyZWF0aW9uRXZlbnRUeXBlLFxuICBpc0hvb2tFdmVudFJlcXVpcmluZ0V4aXN0ZW5jZSxcbiAgaXNMZWdhY3lTcGVjVmVyc2lvbixcbiAgaXNUZXJtaW5hbFJ1bkV2ZW50VHlwZSxcbiAgaXNUZXJtaW5hbFN0ZXBTdGF0dXMsXG4gIGlzVGVybWluYWxXb3JrZmxvd1J1blN0YXR1cyxcbiAgcmVxdWlyZXNOZXdlcldvcmxkLFxuICBTUEVDX1ZFUlNJT05fQ1VSUkVOVCxcbiAgU3RlcFNjaGVtYSxcbiAgc2xvdFRvRXZlbnRJZCxcbiAgc3RyaXBFdmVudERhdGFSZWZzLFxuICBURVJNSU5BTF9TVEVQX1NUQVRVU0VTLFxuICBURVJNSU5BTF9XT1JLRkxPV19SVU5fU1RBVFVTRVMsXG4gIHZhbGlkYXRlQXR0cmlidXRlQ2hhbmdlcyxcbiAgdmFsaWRhdGVVbGlkVGltZXN0YW1wLFxuICBXb3JrZmxvd1J1blNjaGVtYSxcbn0gZnJvbSAnQHdvcmtmbG93L3dvcmxkJztcbmltcG9ydCB7XG4gIGFuZCxcbiAgYXNjLFxuICBkZXNjLFxuICBlcSxcbiAgZXhpc3RzLFxuICBndCxcbiAgaW5BcnJheSxcbiAgaXNOdWxsLFxuICBsdCxcbiAgbHRlLFxuICBub3RFeGlzdHMsXG4gIG5vdEluQXJyYXksXG4gIG9yLFxuICB0eXBlIFNRTCxcbiAgc3FsLFxufSBmcm9tICdkcml6emxlLW9ybSc7XG5pbXBvcnQgeyBtb25vdG9uaWNGYWN0b3J5IH0gZnJvbSAndWxpZCc7XG5pbXBvcnQgeyB0eXBlIERyaXp6bGUsIFNjaGVtYSB9IGZyb20gJy4vZHJpenpsZS9pbmRleC5qcyc7XG5pbXBvcnQgdHlwZSB7IFNlcmlhbGl6ZWRDb250ZW50IH0gZnJvbSAnLi9kcml6emxlL3NjaGVtYS5qcyc7XG5pbXBvcnQgeyBjb21wYWN0IH0gZnJvbSAnLi91dGlsLmpzJztcblxuY29uc3QgREFZX01TID0gMjQgKiA2MCAqIDYwICogMTAwMDtcblxuLyoqXG4gKiBBIGRyaXp6bGUgaGFuZGxlLCBlaXRoZXIgdGhlIHBvb2wgb3IgYSB0cmFuc2FjdGlvbi4gU2xvdCBhbGxvY2F0aW9uIHJ1bnMgb25cbiAqIHdoaWNoZXZlciBvbmUgdGhlIGNhbGxlciBpcyBhbHJlYWR5IGluc2lkZSwgc28gdGhlIHBvc2l0aW9uIGFuIGluc2VydCB0YWtlc1xuICogY29tbWl0cyBvciByb2xscyBiYWNrIHdpdGggdGhlIGluc2VydCBpdHNlbGYuXG4gKi9cbnR5cGUgRHJpenpsZUxpa2UgPSBQaWNrPERyaXp6bGUsICdpbnNlcnQnIHwgJ3VwZGF0ZScgfCAnc2VsZWN0Jz47XG5cbi8qKiBPbmx5IGZvciBsZWdhY3kgKHByZS1zbG90KSBydW5zOyBzZWUgYGFsbG9jYXRlRXZlbnRJZGAuICovXG5jb25zdCBsZWdhY3lFdmVudFVsaWQgPSBtb25vdG9uaWNGYWN0b3J5KCk7XG5cbi8qKlxuICogSG93IG1hbnkgcG9zaXRpb25zIG9uZSBpbnNlcnQgd2lsbCB0cnkgYmVmb3JlIGdpdmluZyB1cC4gUmVhY2hlZCBvbmx5IHdoZW4gYVxuICogcnVuIGlzIHRha2luZyBjb25jdXJyZW50IHdyaXRlcyBmYXN0ZXIgdGhhbiBhbnkgb2YgdGhlbSBjYW4gY29tbWl0LlxuICovXG5jb25zdCBTTE9UX0lOU0VSVF9NQVhfQVRURU1QVFMgPSA0MDtcbi8qKlxuICogQ29sbGlzaW9ucyB0aGF0IHJldHJ5IHRoZSBpbnN0YW50IHRoZSBjb25mbGljdGluZyB3cml0ZXIgc2V0dGxlcy5cbiAqXG4gKiBgT04gQ09ORkxJQ1QgRE8gTk9USElOR2AgZG9lcyBub3Qgc2tpcCBhbiB1bmNvbW1pdHRlZCBjb25mbGljdGluZyByb3c6IHRoZVxuICogdW5pcXVlLWluZGV4IGNoZWNrIHdhaXRzIG9uIHRoYXQgd3JpdGVyJ3MgdHJhbnNhY3Rpb24gYW5kIG9ubHkgdGhlbiByZXBvcnRzXG4gKiB0aGUgY29uZmxpY3QsIHNvIGEgbG9zdCByYWNlIGhhcyBhbHJlYWR5IHdhaXRlZCBmb3IgZXhhY3RseSB0aGUgdGhpbmcgdGhlXG4gKiBuZXh0IHBvc2l0aW9uIGRlcGVuZHMgb24uIFNsZWVwaW5nIG9uIHRvcCBvZiB0aGF0IGFkZHMgbGF0ZW5jeSB0byBhXG4gKiBzdXNwZW5zaW9uIGZsdXNoIGFuZCBidXlzIG5vdGhpbmcuXG4gKlxuICogVGhlIGJhY2tvZmYgYmVsb3cgY292ZXJzIHRoZSBzaGFwZSBibG9ja2luZyBkb2VzIG5vdDogd3JpdGVycyB0aGF0IGtlZXBcbiAqIGFycml2aW5nIHdoaWxlIHRoZSBsb29wIHNwaW5zLCB3aGVyZSBqaXR0ZXJpbmcgdGhlIGhlcmQgaXMgdGhlIG9ubHkgd2F5IHRoZVxuICogbG9vcCBjb252ZXJnZXMgYmVmb3JlIGl0IGV4aGF1c3RzIGl0cyBhdHRlbXB0cy5cbiAqL1xuY29uc3QgU0xPVF9JTlNFUlRfSU1NRURJQVRFX0FUVEVNUFRTID0gODtcbi8qKiBCYWNrb2ZmIGJldHdlZW4gY29sbGlzaW9ucywgc28gYSB3aWRlIGZhbi1vdXQgc3ByZWFkcyByYXRoZXIgdGhhbiBsb2Nrc3RlcC4gKi9cbmNvbnN0IFNMT1RfSU5TRVJUX0JBU0VfREVMQVlfTVMgPSAyO1xuY29uc3QgU0xPVF9JTlNFUlRfTUFYX0RFTEFZX01TID0gNDA7XG5cbi8qKlxuICogSXNvbGF0aW9uIGZvciBldmVyeSB0cmFuc2FjdGlvbiBhbiBldmVudCBpbnNlcnQgY2FuIHJ1biBpbnNpZGUuXG4gKlxuICoge0BsaW5rIGluc2VydEV2ZW50Um93fSBhbnN3ZXJzIGEgY29sbGlzaW9uIGJ5IHJlY29tcHV0aW5nIHRoZSBuZXh0IHBvc2l0aW9uXG4gKiBhbmQgaW5zZXJ0aW5nIGFnYWluLCB3aGljaCBvbmx5IHRlcm1pbmF0ZXMgaWYgdGhlIHJldHJ5IGNhbiBzZWUgcm93c1xuICogY29tbWl0dGVkIHNpbmNlIHRoZSB0cmFuc2FjdGlvbiBiZWdhbi4gVW5kZXIgUkVQRUFUQUJMRSBSRUFEIG9yIFNFUklBTElaQUJMRVxuICogaXQgY2Fubm90OiBldmVyeSBhdHRlbXB0IHJlYWRzIHRoZSB0cmFuc2FjdGlvbidzIG9yaWdpbmFsIHNuYXBzaG90LCBjb21wdXRlc1xuICogdGhlIHNhbWUgdGFrZW4gcG9zaXRpb24sIGFuZCB0aGUgbG9vcCBydW5zIHRvIGl0cyBsaW1pdCBhbmQgNTAzcy4gUkVBRFxuICogQ09NTUlUVEVEIGlzIFBvc3RncmVzJyBkZWZhdWx0LCBzbyB0aGlzIGlzIGEgc3RhdGVtZW50IG9mIHRoZSByZXF1aXJlbWVudFxuICogcmF0aGVyIHRoYW4gYSBjaGFuZ2UsIGFuZCBpdCBrZWVwcyBhIGRhdGFiYXNlIHdob3NlXG4gKiBgZGVmYXVsdF90cmFuc2FjdGlvbl9pc29sYXRpb25gIHdhcyByYWlzZWQgZnJvbSB0dXJuaW5nIGV2ZW50IHdyaXRlcyBpbnRvXG4gKiB0aW1lb3V0cy4gSW5zZXJ0cyBvdXRzaWRlIGEgdHJhbnNhY3Rpb24gbmVlZCBub3RoaW5nOiBhIGxvbmUgc3RhdGVtZW50IHRha2VzXG4gKiBhIGZyZXNoIHNuYXBzaG90IGF0IGV2ZXJ5IGlzb2xhdGlvbiBsZXZlbC5cbiAqL1xuY29uc3QgU0xPVF9JTlNFUlRfVFJBTlNBQ1RJT04gPSB7IGlzb2xhdGlvbkxldmVsOiAncmVhZCBjb21taXR0ZWQnIH0gYXMgY29uc3Q7XG5cbi8qKiBUaGUgcGcgZXJyb3IgYmVoaW5kIGEgZHJpenpsZSB3cmFwcGVyLCBvciBhbiBlbXB0eSBzaGFwZSBpZiB0aGVyZSBpcyBub25lLiAqL1xuZnVuY3Rpb24gcGdFcnJvck9mKGVycjogdW5rbm93bik6IHsgY29kZT86IHN0cmluZzsgY29uc3RyYWludD86IHN0cmluZyB9IHtcbiAgY29uc3QgZGlyZWN0ID0gZXJyIGFzIHsgY29kZT86IHN0cmluZzsgY29uc3RyYWludD86IHN0cmluZyB9O1xuICBpZiAoZGlyZWN0Py5jb2RlKSB7XG4gICAgcmV0dXJuIGRpcmVjdDtcbiAgfVxuICByZXR1cm4gKFxuICAgIChlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHN0cmluZzsgY29uc3RyYWludD86IHN0cmluZyB9IH0pPy5jYXVzZSA/PyB7fVxuICApO1xufVxuXG4vKipcbiAqIFRoZSBwb3NpdGlvbiBhIHNsb3QtbnVtYmVyZWQgaW5zZXJ0IHRha2VzOiBvbmUgYWJvdmUgdGhlIGhpZ2hlc3QgdGhlIHJ1blxuICogYWxyZWFkeSBob2xkcywgcmVhZCBpbnNpZGUgdGhlIElOU0VSVCB0aGF0IHRha2VzIGl0LlxuICpcbiAqIE5vdGhpbmcgaGFuZHMgb3V0IGEgcG9zaXRpb24gYWhlYWQgb2YgdGhlIHdyaXRlIHRoYXQgZmlsbHMgaXQuIEEgd3JpdGVyIHRoYXRcbiAqIGxvc2VzIGEgZGVkdXAgcmFjZSwgb3Igd2hvc2UgdHJhbnNhY3Rpb24gcm9sbHMgYmFjaywgbGVhdmVzIHRoZSBudW1iZXJpbmdcbiAqIHVudG91Y2hlZCwgc28gYSBsb2cgbWlzc2luZyBhIHBvc2l0aW9uIGlzIG1pc3NpbmcgYW4gKmV2ZW50KiByYXRoZXIgdGhhblxuICogbWVyZWx5IGEgbnVtYmVyLiBUaGUgcnVudGltZSBkZXBlbmRzIG9uIGV4YWN0bHkgdGhhdDogaXQgcmVmdXNlcyB0byByZXBsYXkgYVxuICogbG9nIHdpdGggYSBob2xlLCBiZWNhdXNlIGEgcG9zaXRpb24gbm90aGluZyBvY2N1cGllcyBjYW5ub3QgYmUgdG9sZCBhcGFydFxuICogZnJvbSBhbiBldmVudCB0aGF0IG5ldmVyIGhhcHBlbmVkLlxuICpcbiAqIEEgY291bnRlciBjb2x1bW4gd291bGQgYmUgY2hlYXBlciBhbmQgaXMgd2hhdCB0aGlzIHVzZWQgdG8gYmUuIEl0IGNhbm5vdFxuICogaG9sZCB0aGF0IHByb3BlcnR5OiBhIG51bWJlciBoYW5kZWQgb3V0IGJlZm9yZSB0aGUgd3JpdGUgbGFuZHMgaXMgYSBudW1iZXJcbiAqIGxvc3Qgd2hlbmV2ZXIgdGhlIHdyaXRlIGRvZXMgbm90LCBhbmQgdGhlIHJlc3VsdGluZyBob2xlcyBhcmUgcGVybWFuZW50LlxuICpcbiAqIFRoZSBzdWJxdWVyeSBpcyBhbiBpbmRleC1vbmx5IHJlYWQgb2YgdGhlIHByaW1hcnkga2V5J3MgbGFzdCByb3cgZm9yIHRoZVxuICogcnVuLCBub3QgYSBzY2FuLiBPcmRlcmluZyBpcyBsZXhpY29ncmFwaGljLCB3aGljaCBpcyB0aGUgc2FtZSBvcmRlciBhcyBieVxuICogcG9zaXRpb24gYmVjYXVzZSBldmVyeSBib2R5IGlzIHplcm8tcGFkZGVkIHRvIGEgZml4ZWQgd2lkdGguXG4gKlxuICogRXZlcnkgbnVtZXJpYyBwYXJhbWV0ZXIgaXMgY2FzdCBleHBsaWNpdGx5LiBgc3Vic3RyaW5nKHRleHQgZnJvbSAkbilgIHdpdGggYW5cbiAqIHVudHlwZWQgcGFyYW1ldGVyIHJlc29sdmVzIHRvIHRoZSAqcmVndWxhciBleHByZXNzaW9uKiBvdmVybG9hZCByYXRoZXIgdGhhblxuICogdGhlIHBvc2l0aW9uYWwgb25lLCB3aGljaCBxdWlldGx5IHJldHVybnMgTlVMTCBmb3IgZXZlcnkgaWQgYW5kIGhhbmRzIGV2ZXJ5XG4gKiB3cml0ZXIgdGhlIGZpcnN0IHNsb3QuXG4gKi9cbmZ1bmN0aW9uIG5leHRTbG90SWQocnVuSWQ6IHN0cmluZyk6IFNRTDxzdHJpbmc+IHtcbiAgY29uc3QgYm9keUZyb20gPSBzcWwucmF3KFN0cmluZyhFVkVOVF9JRF9QUkVGSVgubGVuZ3RoICsgMSkpO1xuICBjb25zdCB3aWR0aCA9IHNxbC5yYXcoU3RyaW5nKEVWRU5UX0lEX0JPRFlfTEVOR1RIKSk7XG4gIGNvbnN0IG5vRXZlbnRzID0gc3FsLnJhdyhTdHJpbmcoRklSU1RfRVZFTlRfU0xPVCAtIDEpKTtcbiAgcmV0dXJuIHNxbDxzdHJpbmc+YCR7RVZFTlRfSURfUFJFRklYfSB8fCBscGFkKChjb2FsZXNjZSgoc2VsZWN0IGNhc3Qoc3Vic3RyaW5nKHByZXYuaWQgZnJvbSAke2JvZHlGcm9tfSkgYXMgYmlnaW50KSBmcm9tICR7U2NoZW1hLmV2ZW50c30gcHJldiB3aGVyZSBwcmV2LnJ1bl9pZCA9ICR7cnVuSWR9IG9yZGVyIGJ5IHByZXYuaWQgZGVzYyBsaW1pdCAxKSwgJHtub0V2ZW50c30pICsgMSk6OnRleHQsICR7d2lkdGh9LCAnMCcpYDtcbn1cblxuLyoqXG4gKiBUaGUgaWQgYW4gaW5zZXJ0IGZvciBgcnVuSWRgIHNob3VsZCBhbGxvY2F0ZSB3aXRoOiBhIHNsb3QgZXhwcmVzc2lvbiBmb3IgYVxuICogc2xvdC1udW1iZXJlZCBydW4sIGEgZnJlc2ggVUxJRCBmb3Igb25lIHRoYXQgcHJlZGF0ZXMgc2xvdHMuXG4gKlxuICogQSByb3cgaW4gYHdvcmtmbG93X2V2ZW50X3Nsb3RzYCBpcyB0aGUgbWFya2VyIGZvciB0aGUgZmlyc3QgY2FzZS4gSXRzXG4gKiBhYnNlbmNlIGlzIGV4YWN0bHkgdGhlIFwidGhpcyBydW4gcHJlZGF0ZXMgc2xvdHNcIiBzaWduYWwsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHRhYmxlIGlzIHN0aWxsIHJlYWQgZXZlbiB0aG91Z2ggbm90aGluZyBhZHZhbmNlcyBpdCBhbnkgbW9yZS5cbiAqXG4gKiBBIGxlZ2FjeSBydW4ga2VlcHMgbWludGluZyB1bmRlciB0aGUgb3JpZ2luYWwgYHdldnRfYCBwcmVmaXggcmF0aGVyIHRoYW5cbiAqIG1vdmluZyB0byBgZXZudF9gOiBhIG1pZC1saWZlIHByZWZpeCBjaGFuZ2Ugd291bGQgc29ydCBldmVyeSBuZXcgZXZlbnRcbiAqIGJlZm9yZSBldmVyeSBvbGQgb25lLCBzaW5jZSBgZXZudF9gIDwgYHdldnRfYC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gYWxsb2NhdGVFdmVudElkKFxuICBkYjogRHJpenpsZUxpa2UsXG4gIHJ1bklkOiBzdHJpbmdcbik6IFByb21pc2U8c3RyaW5nIHwgU1FMPHN0cmluZz4+IHtcbiAgY29uc3QgW3Jvd10gPSBhd2FpdCBkYlxuICAgIC5zZWxlY3QoeyBydW5JZDogU2NoZW1hLmV2ZW50U2xvdHMucnVuSWQgfSlcbiAgICAuZnJvbShTY2hlbWEuZXZlbnRTbG90cylcbiAgICAud2hlcmUoZXEoU2NoZW1hLmV2ZW50U2xvdHMucnVuSWQsIHJ1bklkKSlcbiAgICAubGltaXQoMSk7XG4gIHJldHVybiByb3cgPyBuZXh0U2xvdElkKHJ1bklkKSA6IGB3ZXZ0XyR7bGVnYWN5RXZlbnRVbGlkKCl9YDtcbn1cblxuLyoqXG4gKiBJbnNlcnRzIG9uZSBldmVudCByb3csIHJldHJ5aW5nIHdoaWxlIHRoZSBwb3NpdGlvbiBpdCBjb21wdXRlZCBpcyB0YWtlbi5cbiAqXG4gKiBUaGUgcHJpbWFyeS1rZXkgY29uZmxpY3QgaXMgYWJzb3JiZWQgYnkgYE9OIENPTkZMSUNUIERPIE5PVEhJTkdgIHJhdGhlciB0aGFuXG4gKiByYWlzZWQsIHNvIGEgbG9zdCByYWNlIGNvc3RzIGEgcmV0cnkgaW5zdGVhZCBvZiB0aGUgZW5jbG9zaW5nIHRyYW5zYWN0aW9uIOKAlFxuICogYW4gZXJyb3IgaW5zaWRlIGEgdHJhbnNhY3Rpb24gd291bGQgcG9pc29uIGl0LCBhbmQgdGhlc2UgaW5zZXJ0cyBydW4gaW4gb25lLlxuICogRXZlcnkgb3RoZXIgdW5pcXVlIHZpb2xhdGlvbiBzdGlsbCByYWlzZXMsIHdoaWNoIGlzIHdoYXQgbGV0cyBjYWxsZXJzXG4gKiB0cmFuc2xhdGUgYSBkZWR1cCBjb25mbGljdCBvbiBgd29ya2Zsb3dfZXZlbnRzX2VudGl0eV9jcmVhdGlvbl91bmlxdWVgLlxuICpcbiAqIFJldHVybnMgYHVuZGVmaW5lZGAgb25seSBmb3IgYW4gaWQgdGhhdCBpcyBhIHBsYWluIHN0cmluZyAoYSBsZWdhY3kgVUxJRCwgb3JcbiAqIHRoZSByZXNlcnZlZCBmaXJzdCBzbG90KSwgd2hlcmUgYSBjb25mbGljdCBpcyB0aGUgY2FsbGVyJ3MgYW5zd2VyIHJhdGhlclxuICogdGhhbiBzb21ldGhpbmcgdG8gcmV0cnkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGluc2VydEV2ZW50Um93KFxuICBkYjogRHJpenpsZUxpa2UsXG4gIHZhbHVlczogT21pdDx0eXBlb2YgU2NoZW1hLmV2ZW50cy4kaW5mZXJJbnNlcnQsICdldmVudElkJz4gJiB7XG4gICAgZXZlbnRJZDogc3RyaW5nIHwgU1FMPHN0cmluZz47XG4gIH1cbik6IFByb21pc2U8eyBldmVudElkOiBzdHJpbmc7IGNyZWF0ZWRBdDogRGF0ZSB9IHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IHJ1bklkID0gdmFsdWVzLnJ1bklkO1xuICBjb25zdCBhbGxvY2F0ZXMgPSB0eXBlb2YgdmFsdWVzLmV2ZW50SWQgIT09ICdzdHJpbmcnO1xuICBmb3IgKGxldCBhdHRlbXB0ID0gMDsgOyBhdHRlbXB0KyspIHtcbiAgICBjb25zdCBbcm93XSA9IGF3YWl0IGRiXG4gICAgICAuaW5zZXJ0KFNjaGVtYS5ldmVudHMpXG4gICAgICAudmFsdWVzKHZhbHVlcyBhcyB0eXBlb2YgU2NoZW1hLmV2ZW50cy4kaW5mZXJJbnNlcnQpXG4gICAgICAub25Db25mbGljdERvTm90aGluZyh7XG4gICAgICAgIHRhcmdldDogW1NjaGVtYS5ldmVudHMucnVuSWQsIFNjaGVtYS5ldmVudHMuZXZlbnRJZF0sXG4gICAgICB9KVxuICAgICAgLnJldHVybmluZyh7XG4gICAgICAgIGV2ZW50SWQ6IFNjaGVtYS5ldmVudHMuZXZlbnRJZCxcbiAgICAgICAgY3JlYXRlZEF0OiBTY2hlbWEuZXZlbnRzLmNyZWF0ZWRBdCxcbiAgICAgIH0pO1xuICAgIGlmIChyb3cpIHtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfVxuICAgIGlmICghYWxsb2NhdGVzIHx8IGF0dGVtcHQgPj0gU0xPVF9JTlNFUlRfTUFYX0FUVEVNUFRTKSB7XG4gICAgICBpZiAoIWFsbG9jYXRlcykge1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgdGhyb3cgbmV3IFdvcmtmbG93V29ybGRFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCBhbGxvY2F0ZSBhbiBldmVudCBzbG90IGZvciBydW4gXCIke3J1bklkfVwiIGFmdGVyICR7U0xPVF9JTlNFUlRfTUFYX0FUVEVNUFRTfSBhdHRlbXB0c2AsXG4gICAgICAgIHsgc3RhdHVzOiA1MDMgfVxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKGF0dGVtcHQgPj0gU0xPVF9JTlNFUlRfSU1NRURJQVRFX0FUVEVNUFRTKSB7XG4gICAgICBjb25zdCBkZWxheSA9IE1hdGgubWluKFxuICAgICAgICBTTE9UX0lOU0VSVF9NQVhfREVMQVlfTVMsXG4gICAgICAgIFNMT1RfSU5TRVJUX0JBU0VfREVMQVlfTVMgKlxuICAgICAgICAgIDIgKiogKGF0dGVtcHQgLSBTTE9UX0lOU0VSVF9JTU1FRElBVEVfQVRURU1QVFMpXG4gICAgICApO1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+XG4gICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgTWF0aC5yYW5kb20oKSAqIGRlbGF5KVxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBNYXJrcyBhIHJ1biBiZWluZyBjcmVhdGVkIGFzIHNsb3QtbnVtYmVyZWQgYW5kIHJldHVybnMgaXRzIGZpcnN0IGV2ZW50IGlkLlxuICpcbiAqIFRoZSByb3cgcmVjb3JkcyB0aGUgc2NoZW1lIGFuZCBub3RoaW5nIGVsc2U7IHBvc2l0aW9ucyBjb21lIGZyb20gdGhlIGxvZ1xuICogaXRzZWxmLCBzZWUge0BsaW5rIG5leHRTbG90SWR9LlxuICpcbiAqIGBETyBOT1RISU5HYCBvbiBjb25mbGljdCBiZWNhdXNlIHRoZSBhcmJpdHJhdGlvbiB0aGF0IG1hdHRlcnMgaXMgdGhlIGV2ZW50XG4gKiBpbnNlcnQ6IHR3byB3cml0ZXJzIHJhY2luZyBvbmUgcnVuX2NyZWF0ZWQgYm90aCB0YWtlIHRoZSBmaXJzdCBzbG90LCBhbmQgdGhlXG4gKiBjb21wb3NpdGUgZXZlbnRzIHByaW1hcnkga2V5IHJlamVjdHMgdGhlIGxvc2VyLlxuICovXG5hc3luYyBmdW5jdGlvbiBvcGVuRXZlbnRTbG90cyhkYjogRHJpenpsZUxpa2UsIHJ1bklkOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBhd2FpdCBkYi5pbnNlcnQoU2NoZW1hLmV2ZW50U2xvdHMpLnZhbHVlcyh7IHJ1bklkIH0pLm9uQ29uZmxpY3REb05vdGhpbmcoKTtcbiAgcmV0dXJuIHNsb3RUb0V2ZW50SWQoRklSU1RfRVZFTlRfU0xPVCk7XG59XG5cbi8qKlxuICogVGhlIHJlcG9ydCBoYWxmIG9mIGJ1bXAtYW5kLXJlcG9ydDogdGhlIGV2ZW50cyBzaXR0aW5nIG9uIHRoZSBzbG90cyBiZXR3ZWVuXG4gKiB0aGUgb25lIHRoZSB3cml0ZXIgYXNrZWQgZm9yIGFuZCB0aGUgb25lIGl0cyB3cml0ZSBhY3R1YWxseSBsYW5kZWQgb24uXG4gKlxuICogUmV0dXJucyBgdW5kZWZpbmVkYCB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVwb3J0IOKAlCB0aGUgd3JpdGUgdG9vayB0aGUgc2xvdFxuICogaXQgYXNrZWQgZm9yLCB0aGUgcnVuIGlzIG5vdCBzbG90LW51bWJlcmVkLCBvciB0aGUgY2FsbGVyIHNlbnQgYSBjb3VudCBmcm9tIGFcbiAqIGxvZyB0aGF0IGlzIGFscmVhZHkgYWhlYWQgb2YgdGhpcyB3cml0ZS5cbiAqXG4gKiBUaGUgc2V0IGNhbiBiZSBzaG9ydCBvZiB0aGUgc2xvdCBzcGFuIGl0IGNvdmVycy4gQSBwb3NpdGlvbiBpcyB0YWtlbiBieSB0aGVcbiAqIElOU0VSVCB0aGF0IGNvbXB1dGVzIGl0LCBhbmQgdGhhdCBJTlNFUlQgY29tbWl0cyBvbiBpdHMgb3duLCBzbyBhdCB0aGUgbW9tZW50XG4gKiB0aGlzIHJlYWRzIHRoZSBzcGFuIGEgY29uY3VycmVudCB3cml0ZXIgaG9sZGluZyBhIGxvd2VyIHBvc2l0aW9uIG1heSBub3QgaGF2ZVxuICogY29tbWl0dGVkIHlldC4gSXRzIHJvdyBhcHBlYXJzIHNob3J0bHkgYWZ0ZXIgYW5kIG5vIHBvc2l0aW9uIGlzIGxlZnQgYmVoaW5kLFxuICogYmVjYXVzZSBhIHdyaXRlIHRoYXQgZmFpbHMgbmV2ZXIgdG9vayBvbmUuIGBoYXNNb3JlYCBzYXlzIHRoZSByZXBvcnQgaXMgYVxuICogbG93ZXIgYm91bmQgZm9yIG5vdyByYXRoZXIgdGhhbiBhIHBlcm1hbmVudCBvbmUsIGFuZCBpdCBpcyBhZHZpc29yeSBlaXRoZXJcbiAqIHdheTogdGhlIGNhbGxlcidzIG9yZGluYXJ5IGluY3JlbWVudGFsIHJlYWQgc3RpbGwgcnVucy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVwb3J0U2tpcHBlZFNsb3RzKFxuICBkYjogRHJpenpsZSxcbiAgcnVuSWQ6IHN0cmluZyxcbiAgY29tbWl0dGVkRXZlbnRJZDogc3RyaW5nLFxuICBhc2tlZEZvcjogbnVtYmVyLFxuICByZXNvbHZlRGF0YTogUmVzb2x2ZURhdGFcbik6IFByb21pc2U8eyBldmVudHM6IEV2ZW50W107IGhhc01vcmU6IGJvb2xlYW4gfSB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCBjb21taXR0ZWRTbG90ID0gZXZlbnRJZFRvU2xvdChjb21taXR0ZWRFdmVudElkKTtcbiAgaWYgKFxuICAgIGNvbW1pdHRlZFNsb3QgPT09IG51bGwgfHxcbiAgICBhc2tlZEZvciA8IEZJUlNUX0VWRU5UX1NMT1QgfHxcbiAgICBjb21taXR0ZWRTbG90IDw9IGFza2VkRm9yICsgMVxuICApIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGNvbnN0IHJvd3MgPSBhd2FpdCBkYlxuICAgIC5zZWxlY3QoKVxuICAgIC5mcm9tKFNjaGVtYS5ldmVudHMpXG4gICAgLndoZXJlKFxuICAgICAgYW5kKFxuICAgICAgICBlcShTY2hlbWEuZXZlbnRzLnJ1bklkLCBydW5JZCksXG4gICAgICAgIGd0KFNjaGVtYS5ldmVudHMuZXZlbnRJZCwgc2xvdFRvRXZlbnRJZChhc2tlZEZvcikpLFxuICAgICAgICBsdChTY2hlbWEuZXZlbnRzLmV2ZW50SWQsIGNvbW1pdHRlZEV2ZW50SWQpXG4gICAgICApXG4gICAgKVxuICAgIC5vcmRlckJ5KFNjaGVtYS5ldmVudHMuZXZlbnRJZCk7XG4gIGNvbnN0IGV2ZW50cyA9IHJvd3MubWFwKChyb3cpID0+IHtcbiAgICByb3cuZXZlbnREYXRhIHx8PSByb3cuZXZlbnREYXRhSnNvbjtcbiAgICByZXR1cm4gc3RyaXBFdmVudERhdGFSZWZzKEV2ZW50U2NoZW1hLnBhcnNlKGNvbXBhY3Qocm93KSksIHJlc29sdmVEYXRhKTtcbiAgfSk7XG4gIHJldHVybiB7XG4gICAgZXZlbnRzLFxuICAgIGhhc01vcmU6IGV2ZW50cy5sZW5ndGggPCBjb21taXR0ZWRTbG90IC0gYXNrZWRGb3IgLSAxLFxuICB9O1xufVxuXG5mdW5jdGlvbiBnZXRIb29rUmV0ZW50aW9uTGltaXRNcygpOiBudW1iZXIge1xuICBjb25zdCBkYXlzID0gTnVtYmVyKFxuICAgIHByb2Nlc3MuZW52LldPUktGTE9XX1BPU1RHUkVTX0hPT0tfUkVURU5USU9OX0xJTUlUX0RBWVMgPz8gMzBcbiAgKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoZGF5cykgfHwgZGF5cyA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtmbG93V29ybGRFcnJvcihcbiAgICAgICdXT1JLRkxPV19QT1NUR1JFU19IT09LX1JFVEVOVElPTl9MSU1JVF9EQVlTIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInLFxuICAgICAgeyBzdGF0dXM6IDQwMCB9XG4gICAgKTtcbiAgfVxuICByZXR1cm4gZGF5cyAqIERBWV9NUztcbn1cblxuLyoqXG4gKiBSZWFkIGhlbHBlciBmb3IgdGhlIGRlcHJlY2F0ZWQgYGVycm9yYCB0ZXh0IGNvbHVtbiAobGVnYWN5OiBKU09OLXN0cmluZ2lmaWVkXG4gKiBgU3RydWN0dXJlZEVycm9yYCkuIEluIHRoZSBjdXJyZW50IGV2ZW50LXNvdXJjZWQgbW9kZWwsIHRoZSBgZXJyb3JgIGZpZWxkIG9uXG4gKiBlbnRpdGllcyBpcyBgU2VyaWFsaXplZERhdGFgIChVaW50OEFycmF5KSBwcm9kdWNlZCBieSB0aGUgbmV3IGVycm9yXG4gKiBzZXJpYWxpemF0aW9uIHBpcGVsaW5lOyBsZWdhY3kgdGV4dC1jb2x1bW4gcmVjb3JkcyBwcmUtZGF0ZSB0aGF0IHBpcGVsaW5lXG4gKiBhbmQgY2Fubm90IGJlIGh5ZHJhdGVkIGJhY2sgaW50byB0aGUgb3JpZ2luYWwgdGhyb3duIHZhbHVlLlxuICpcbiAqIFJldHVybnMgYG51bGxgIHVuY29uZGl0aW9uYWxseSBzbyBkb3duc3RyZWFtIGNvbnN1bWVycyB0cmVhdCBsZWdhY3kgZXJyb3JzXG4gKiBhcyBhYnNlbnQgcmF0aGVyIHRoYW4gcmVjZWl2aW5nIGEgc2hhcGUgdGhhdCBgaHlkcmF0ZVN0ZXBFcnJvcmAgL1xuICogYGh5ZHJhdGVSdW5FcnJvcmAgY2FuJ3QgcHJvY2Vzcy4gQ2FsbGVycyB0aGF0IG5lZWQgdG8gaW5zcGVjdCB0aGUgcmF3XG4gKiBsZWdhY3kgcGF5bG9hZCBzaG91bGQgcmVhZCB0aGUgYGVycm9ySnNvbmAgY29sdW1uIGRpcmVjdGx5LlxuICovXG5mdW5jdGlvbiBwYXJzZUVycm9ySnNvbihfZXJyb3JKc29uOiBzdHJpbmcgfCBudWxsKTogU2VyaWFsaXplZERhdGEgfCBudWxsIHtcbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogUGFzcy10aHJvdWdoIGhlbHBlciBrZXB0IGZvciBiYWNrd2FyZHMgY29tcGF0aWJpbGl0eSB3aXRoIHRoZSBydW4gcmVhZCBwYXRoLlxuICogSW4gdGhlIGN1cnJlbnQgZXZlbnQtc291cmNlZCBtb2RlbCwgYGVycm9yYCBpcyBhbHJlYWR5IGBTZXJpYWxpemVkRGF0YWBcbiAqIChVaW50OEFycmF5KSBvbiB0aGUgZW50aXR5LCBhbmQgYW55IGxlZ2FjeSBgZXJyb3JTdGFja2AgLyBgZXJyb3JDb2RlYFxuICogZmllbGRzIGFyZSBubyBsb25nZXIgcG9wdWxhdGVkIGJ5IHRoZSBjdXJyZW50IHdyaXRlIHBhdGguXG4gKi9cbmZ1bmN0aW9uIGRlc2VyaWFsaXplUnVuRXJyb3IocnVuOiBhbnkpOiBXb3JrZmxvd1J1biB7XG4gIC8vIERyb3AgYW55IHN0YWxlIGxlZ2FjeS1vbmx5IGZpZWxkcyB3ZSBtaWdodCBzdGlsbCBlbmNvdW50ZXIgb24gcmVhZC5cbiAgY29uc3QgeyBlcnJvclN0YWNrOiBfZXJyb3JTdGFjaywgLi4ucmVzdCB9ID0gcnVuO1xuICByZXR1cm4gcmVzdCBhcyBXb3JrZmxvd1J1bjtcbn1cblxuLyoqXG4gKiBEZXNlcmlhbGl6ZSBzdGVwIGRhdGEsIG1hcHBpbmcgREIgY29sdW1ucyB0byBpbnRlcmZhY2UgZmllbGRzLlxuICogVGhlIGVycm9yIGZpZWxkIHNob3VsZCBhbHJlYWR5IGJlIGRlc2VyaWFsaXplZCBmcm9tIENCT1Igb3IgZmFsbGJhY2sgdG8gZXJyb3JKc29uLlxuICovXG5mdW5jdGlvbiBkZXNlcmlhbGl6ZVN0ZXBFcnJvcihzdGVwOiBhbnkpOiBTdGVwIHtcbiAgY29uc3QgeyBzdGFydGVkQXQsIC4uLnJlc3QgfSA9IHN0ZXA7XG5cbiAgcmV0dXJuIHtcbiAgICAuLi5yZXN0LFxuICAgIHN0YXJ0ZWRBdCxcbiAgfSBhcyBTdGVwO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUnVuc1N0b3JhZ2UoZHJpenpsZTogRHJpenpsZSk6IFN0b3JhZ2VbJ3J1bnMnXSB7XG4gIGNvbnN0IHsgcnVucyB9ID0gU2NoZW1hO1xuICBjb25zdCBnZXQgPSBkcml6emxlXG4gICAgLnNlbGVjdCgpXG4gICAgLmZyb20ocnVucylcbiAgICAud2hlcmUoZXEocnVucy5ydW5JZCwgc3FsLnBsYWNlaG9sZGVyKCdpZCcpKSlcbiAgICAubGltaXQoMSlcbiAgICAucHJlcGFyZSgnd29ya2Zsb3dfcnVuc19nZXQnKTtcblxuICByZXR1cm4ge1xuICAgIGdldDogKGFzeW5jIChpZCwgcGFyYW1zKSA9PiB7XG4gICAgICBjb25zdCBbdmFsdWVdID0gYXdhaXQgZ2V0LmV4ZWN1dGUoeyBpZCB9KTtcbiAgICAgIGlmICghdmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93UnVuTm90Rm91bmRFcnJvcihpZCk7XG4gICAgICB9XG4gICAgICB2YWx1ZS5vdXRwdXQgfHw9IHZhbHVlLm91dHB1dEpzb247XG4gICAgICB2YWx1ZS5pbnB1dCB8fD0gdmFsdWUuaW5wdXRKc29uO1xuICAgICAgdmFsdWUuZXhlY3V0aW9uQ29udGV4dCB8fD0gdmFsdWUuZXhlY3V0aW9uQ29udGV4dEpzb247XG4gICAgICB2YWx1ZS5lcnJvciB8fD0gcGFyc2VFcnJvckpzb24odmFsdWUuZXJyb3JKc29uKTtcbiAgICAgIGNvbnN0IGRlc2VyaWFsaXplZCA9IGRlc2VyaWFsaXplUnVuRXJyb3IoY29tcGFjdCh2YWx1ZSkpO1xuICAgICAgY29uc3QgcGFyc2VkID0gV29ya2Zsb3dSdW5TY2hlbWEucGFyc2UoZGVzZXJpYWxpemVkKTtcbiAgICAgIGNvbnN0IHJlc29sdmVEYXRhID0gcGFyYW1zPy5yZXNvbHZlRGF0YSA/PyAnYWxsJztcbiAgICAgIHJldHVybiBmaWx0ZXJSdW5EYXRhKHBhcnNlZCwgcmVzb2x2ZURhdGEpO1xuICAgIH0pIGFzIFN0b3JhZ2VbJ3J1bnMnXVsnZ2V0J10sXG4gICAgZ2V0TWFueTogKGFzeW5jIChpZHMsIHBhcmFtcykgPT4ge1xuICAgICAgY29uc3QgdW5pcXVlSWRzID0gWy4uLm5ldyBTZXQoaWRzKV07XG4gICAgICBpZiAodW5pcXVlSWRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gW107XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZhbHVlcyA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgLnNlbGVjdCgpXG4gICAgICAgIC5mcm9tKHJ1bnMpXG4gICAgICAgIC53aGVyZShpbkFycmF5KHJ1bnMucnVuSWQsIHVuaXF1ZUlkcykpO1xuICAgICAgY29uc3QgcmVzb2x2ZURhdGEgPSBwYXJhbXM/LnJlc29sdmVEYXRhID8/ICdhbGwnO1xuICAgICAgY29uc3QgcnVuc0J5SWQgPSBuZXcgTWFwKFxuICAgICAgICB2YWx1ZXMubWFwKCh2YWx1ZSkgPT4ge1xuICAgICAgICAgIHZhbHVlLm91dHB1dCB8fD0gdmFsdWUub3V0cHV0SnNvbjtcbiAgICAgICAgICB2YWx1ZS5pbnB1dCB8fD0gdmFsdWUuaW5wdXRKc29uO1xuICAgICAgICAgIHZhbHVlLmV4ZWN1dGlvbkNvbnRleHQgfHw9IHZhbHVlLmV4ZWN1dGlvbkNvbnRleHRKc29uO1xuICAgICAgICAgIHZhbHVlLmVycm9yIHx8PSBwYXJzZUVycm9ySnNvbih2YWx1ZS5lcnJvckpzb24pO1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IFdvcmtmbG93UnVuU2NoZW1hLnBhcnNlKFxuICAgICAgICAgICAgZGVzZXJpYWxpemVSdW5FcnJvcihjb21wYWN0KHZhbHVlKSlcbiAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybiBbdmFsdWUucnVuSWQsIGZpbHRlclJ1bkRhdGEocGFyc2VkLCByZXNvbHZlRGF0YSldIGFzIGNvbnN0O1xuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgcmV0dXJuIGlkcy5tYXAoKGlkKSA9PiBydW5zQnlJZC5nZXQoaWQpID8/IG51bGwpO1xuICAgIH0pIGFzIE5vbk51bGxhYmxlPFN0b3JhZ2VbJ3J1bnMnXVsnZ2V0TWFueSddPixcbiAgICBsaXN0OiAoYXN5bmMgKHBhcmFtcykgPT4ge1xuICAgICAgY29uc3QgbGltaXQgPSBwYXJhbXM/LnBhZ2luYXRpb24/LmxpbWl0ID8/IDIwO1xuICAgICAgY29uc3QgZnJvbUN1cnNvciA9IHBhcmFtcz8ucGFnaW5hdGlvbj8uY3Vyc29yO1xuXG4gICAgICBjb25zdCBhbGwgPSBhd2FpdCBkcml6emxlXG4gICAgICAgIC5zZWxlY3QoKVxuICAgICAgICAuZnJvbShydW5zKVxuICAgICAgICAud2hlcmUoXG4gICAgICAgICAgYW5kKFxuICAgICAgICAgICAgbWFwKGZyb21DdXJzb3IsIChjKSA9PiBsdChydW5zLnJ1bklkLCBjKSksXG4gICAgICAgICAgICBtYXAocGFyYW1zPy53b3JrZmxvd05hbWUsICh3ZikgPT4gZXEocnVucy53b3JrZmxvd05hbWUsIHdmKSksXG4gICAgICAgICAgICBtYXAocGFyYW1zPy5zdGF0dXMsICh3ZikgPT4gZXEocnVucy5zdGF0dXMsIHdmKSlcbiAgICAgICAgICApXG4gICAgICAgIClcbiAgICAgICAgLm9yZGVyQnkoZGVzYyhydW5zLnJ1bklkKSlcbiAgICAgICAgLmxpbWl0KGxpbWl0ICsgMSk7XG4gICAgICBjb25zdCB2YWx1ZXMgPSBhbGwuc2xpY2UoMCwgbGltaXQpO1xuICAgICAgY29uc3QgaGFzTW9yZSA9IGFsbC5sZW5ndGggPiBsaW1pdDtcblxuICAgICAgY29uc3QgcmVzb2x2ZURhdGEgPSBwYXJhbXM/LnJlc29sdmVEYXRhID8/ICdhbGwnO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGF0YTogdmFsdWVzLm1hcCgodikgPT4ge1xuICAgICAgICAgIHYub3V0cHV0IHx8PSB2Lm91dHB1dEpzb247XG4gICAgICAgICAgdi5pbnB1dCB8fD0gdi5pbnB1dEpzb247XG4gICAgICAgICAgdi5leGVjdXRpb25Db250ZXh0IHx8PSB2LmV4ZWN1dGlvbkNvbnRleHRKc29uO1xuICAgICAgICAgIHYuZXJyb3IgfHw9IHBhcnNlRXJyb3JKc29uKHYuZXJyb3JKc29uKTtcbiAgICAgICAgICBjb25zdCBkZXNlcmlhbGl6ZWQgPSBkZXNlcmlhbGl6ZVJ1bkVycm9yKGNvbXBhY3QodikpO1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IFdvcmtmbG93UnVuU2NoZW1hLnBhcnNlKGRlc2VyaWFsaXplZCk7XG4gICAgICAgICAgcmV0dXJuIGZpbHRlclJ1bkRhdGEocGFyc2VkLCByZXNvbHZlRGF0YSk7XG4gICAgICAgIH0pLFxuICAgICAgICBoYXNNb3JlLFxuICAgICAgICBjdXJzb3I6IHZhbHVlcy5hdCgtMSk/LnJ1bklkID8/IG51bGwsXG4gICAgICB9O1xuICAgIH0pIGFzIFN0b3JhZ2VbJ3J1bnMnXVsnbGlzdCddLFxuXG4gICAgZXhwZXJpbWVudGFsU2V0QXR0cmlidXRlczogYXN5bmMgKFxuICAgICAgcnVuSWQ6IHN0cmluZyxcbiAgICAgIGNoYW5nZXM6IEF0dHJpYnV0ZUNoYW5nZVtdLFxuICAgICAgb3B0aW9ucz86IHsgYWxsb3dSZXNlcnZlZEF0dHJpYnV0ZXM/OiBib29sZWFuIH1cbiAgICApOiBQcm9taXNlPEV4cGVyaW1lbnRhbFNldEF0dHJpYnV0ZXNSZXN1bHQ+ID0+IHtcbiAgICAgIC8vIExvYWQgZXhpc3RpbmcgYXR0cmlidXRlcyBzbyB0aGUgU0RLLXNoYXBlIHZhbGlkYXRvciBjYW4gcHJvZHVjZVxuICAgICAgLy8gYSBwcmVjaXNlIGVycm9yIG1lc3NhZ2UgKGNhcCwgZHVwbGljYXRlIGtleXMsIHJlc2VydmVkIHByZWZpeCxcbiAgICAgIC8vIGJ5dGUgbGVuZ3RoKS4gVGhlIGF1dGhvcml0YXRpdmUgY2FwIGVuZm9yY2VtZW50IGhhcHBlbnMgaW5zaWRlXG4gICAgICAvLyB0aGUgVVBEQVRFIHN0YXRlbWVudCBiZWxvdyDigJQgc2VlIHRoZSBgV0hFUkVgIGNsYXVzZSDigJQgc28gdGhlXG4gICAgICAvLyByYWNlIGJldHdlZW4gdGhpcyByZWFkIGFuZCB0aGUgVVBEQVRFIGNhbm5vdCBwdXNoIHRoZSByb3cgcGFzdFxuICAgICAgLy8gdGhlIHBlci1ydW4gY2FwLlxuICAgICAgY29uc3QgW2V4aXN0aW5nXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgLnNlbGVjdCh7IGF0dHJpYnV0ZXM6IHJ1bnMuYXR0cmlidXRlcyB9KVxuICAgICAgICAuZnJvbShydW5zKVxuICAgICAgICAud2hlcmUoZXEocnVucy5ydW5JZCwgcnVuSWQpKVxuICAgICAgICAubGltaXQoMSk7XG4gICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3IocnVuSWQpO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICB2YWxpZGF0ZUF0dHJpYnV0ZUNoYW5nZXMoY2hhbmdlcywge1xuICAgICAgICAgIGV4aXN0aW5nS2V5czogT2JqZWN0LmtleXMoZXhpc3RpbmcuYXR0cmlidXRlcyA/PyB7fSksXG4gICAgICAgICAgYWxsb3dSZXNlcnZlZEF0dHJpYnV0ZXM6IG9wdGlvbnM/LmFsbG93UmVzZXJ2ZWRBdHRyaWJ1dGVzLFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgQXR0cmlidXRlVmFsaWRhdGlvbkVycm9yKSB0aHJvdyBlcnI7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cblxuICAgICAgLy8gQnVpbGQgYSBzaW5nbGUgU1FMIGV4cHJlc3Npb24gdGhhdCBhcHBsaWVzIGFsbCBjaGFuZ2VzXG4gICAgICAvLyBhdG9taWNhbGx5LiBTZXRzIGZvbGQgaW50byBuZXN0ZWQgYGpzb25iX3NldGAgY2FsbHM7IHJlbW92ZXNcbiAgICAgIC8vIGZvbGQgaW50byBjaGFpbmVkIGAtYCAoZGVsZXRlKSBvcGVyYXRvcnMuXG4gICAgICBsZXQgZXhwciA9IHNxbGBDT0FMRVNDRSgke3J1bnMuYXR0cmlidXRlc30sICd7fSc6Ompzb25iKWA7XG4gICAgICBmb3IgKGNvbnN0IHsga2V5LCB2YWx1ZSB9IG9mIGNoYW5nZXMpIHtcbiAgICAgICAgaWYgKHZhbHVlID09PSBudWxsKSB7XG4gICAgICAgICAgZXhwciA9IHNxbGAke2V4cHJ9IC0gJHtrZXl9YDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBleHByID0gc3FsYGpzb25iX3NldCgke2V4cHJ9LCBBUlJBWVske2tleX1dOjp0ZXh0W10sIHRvX2pzb25iKCR7dmFsdWV9Ojp0ZXh0KSwgdHJ1ZSlgO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEF0b21pYyBjYXAgZW5mb3JjZW1lbnQ6IG9ubHkgY29tbWl0IHRoZSBVUERBVEUgaWYgdGhlXG4gICAgICAvLyBwb3N0LW1lcmdlIGtleSBjb3VudCBmaXRzIHRoZSBwZXItcnVuIGNhcC4gQ29tcHV0ZWQgYWdhaW5zdFxuICAgICAgLy8gdGhlICpjdXJyZW50KiByb3cgc3RhdGUsIHNvIHR3byBjb25jdXJyZW50IHdyaXRlcnMgYWRkaW5nXG4gICAgICAvLyBkaXNqb2ludCBrZXlzIGF0IHRoZSBjYXAgYm91bmRhcnkgY2Fubm90IGJvdGggc3VjY2VlZC5cbiAgICAgIC8vIERyaXp6bGUgcmUtcmVuZGVycyBgZXhwcmAgdHdpY2UgaW4gdGhlIFNRTCAoYFNFVCBhdHRyaWJ1dGVzID1cbiAgICAgIC8vIC4uLmAgKyB0aGUgY291bnQgY2hlY2spOyBganNvbmJfc2V0YCBpcyBjaGVhcCBzbyB0aGVcbiAgICAgIC8vIGR1cGxpY2F0aW9uIGlzIGhhcm1sZXNzLlxuICAgICAgY29uc3QgW3VwZGF0ZWRdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAudXBkYXRlKHJ1bnMpXG4gICAgICAgIC5zZXQoe1xuICAgICAgICAgIGF0dHJpYnV0ZXM6IGV4cHIgYXMgYW55LFxuICAgICAgICAgIHVwZGF0ZWRBdDogbmV3IERhdGUoKSxcbiAgICAgICAgfSlcbiAgICAgICAgLndoZXJlKFxuICAgICAgICAgIGFuZChcbiAgICAgICAgICAgIGVxKHJ1bnMucnVuSWQsIHJ1bklkKSxcbiAgICAgICAgICAgIHNxbGAoU0VMRUNUIENPVU5UKCopIEZST00ganNvbmJfb2JqZWN0X2tleXMoJHtleHByfSkpIDw9ICR7QVRUUklCVVRFX01BWF9QRVJfUlVOfWBcbiAgICAgICAgICApXG4gICAgICAgIClcbiAgICAgICAgLnJldHVybmluZyh7IGF0dHJpYnV0ZXM6IHJ1bnMuYXR0cmlidXRlcyB9KTtcblxuICAgICAgaWYgKCF1cGRhdGVkKSB7XG4gICAgICAgIC8vIEVpdGhlciB0aGUgcnVuIHZhbmlzaGVkIG1pZC1jYWxsLCBvciB0aGUgY2FwLWNoZWNrIFdIRVJFXG4gICAgICAgIC8vIGNsYXVzZSByZWplY3RlZCB0aGUgVVBEQVRFLiBSZS1yZWFkIHRvIGRpc2FtYmlndWF0ZS5cbiAgICAgICAgY29uc3QgW3N0aWxsVGhlcmVdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgIC5zZWxlY3QoeyBhdHRyaWJ1dGVzOiBydW5zLmF0dHJpYnV0ZXMgfSlcbiAgICAgICAgICAuZnJvbShydW5zKVxuICAgICAgICAgIC53aGVyZShlcShydW5zLnJ1bklkLCBydW5JZCkpXG4gICAgICAgICAgLmxpbWl0KDEpO1xuICAgICAgICBpZiAoIXN0aWxsVGhlcmUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dSdW5Ob3RGb3VuZEVycm9yKHJ1bklkKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBuZXcgQXR0cmlidXRlVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgIGBSdW4gYXR0cmlidXRlIGNvdW50IHdvdWxkIGV4Y2VlZCBsaW1pdCAke0FUVFJJQlVURV9NQVhfUEVSX1JVTn0gYWZ0ZXIgY29uY3VycmVudCB3cml0ZWBcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHsgYXR0cmlidXRlczogdXBkYXRlZC5hdHRyaWJ1dGVzID8/IHt9IH07XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFwPFQsIFI+KG9iajogVCB8IG51bGwgfCB1bmRlZmluZWQsIGZuOiAodjogVCkgPT4gUik6IHVuZGVmaW5lZCB8IFIge1xuICByZXR1cm4gb2JqID8gZm4ob2JqKSA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBIYW5kbGUgZXZlbnRzIGZvciBsZWdhY3kgcnVucyAocHJlLWV2ZW50LXNvdXJjaW5nLCBzcGVjVmVyc2lvbiA8IDIpLlxuICogTGVnYWN5IHJ1bnMgdXNlIGRpZmZlcmVudCBiZWhhdmlvcjpcbiAqIC0gcnVuX2NhbmNlbGxlZDogU2tpcCBldmVudCBzdG9yYWdlLCBkaXJlY3RseSB1cGRhdGUgcnVuXG4gKiAtIHdhaXRfY29tcGxldGVkOiBTdG9yZSBldmVudCBvbmx5IChubyBlbnRpdHkgbXV0YXRpb24pXG4gKiAtIGhvb2tfcmVjZWl2ZWQ6IFN0b3JlIGV2ZW50IG9ubHkgKGhvb2tzIGV4aXN0IHZpYSBvbGQgc3lzdGVtLCBubyBlbnRpdHkgbXV0YXRpb24pXG4gKiAtIE90aGVyIGV2ZW50czogVGhyb3cgZXJyb3IgKG5vdCBzdXBwb3J0ZWQgZm9yIGxlZ2FjeSBydW5zKVxuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVMZWdhY3lFdmVudFBvc3RncmVzKFxuICBkcml6emxlOiBEcml6emxlLFxuICBydW5JZDogc3RyaW5nLFxuICBldmVudElkOiBzdHJpbmcsXG4gIGRhdGE6IGFueSxcbiAgY3VycmVudFJ1bjogeyBzdGF0dXM6IHN0cmluZzsgc3BlY1ZlcnNpb246IG51bWJlciB8IG51bGwgfSxcbiAgcGFyYW1zPzogeyByZXNvbHZlRGF0YT86IFJlc29sdmVEYXRhIH1cbik6IFByb21pc2U8RXZlbnRSZXN1bHQ+IHtcbiAgY29uc3QgcmVzb2x2ZURhdGEgPSBwYXJhbXM/LnJlc29sdmVEYXRhID8/ICdhbGwnO1xuXG4gIHN3aXRjaCAoZGF0YS5ldmVudFR5cGUpIHtcbiAgICBjYXNlICdydW5fY2FuY2VsbGVkJzoge1xuICAgICAgLy8gTGVnYWN5OiBTa2lwIGV2ZW50IHN0b3JhZ2UsIGRpcmVjdGx5IHVwZGF0ZSBydW4gdG8gY2FuY2VsbGVkXG4gICAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuXG4gICAgICAvLyBVcGRhdGUgcnVuIHN0YXR1cyB0byBjYW5jZWxsZWRcbiAgICAgIGF3YWl0IGRyaXp6bGVcbiAgICAgICAgLnVwZGF0ZShTY2hlbWEucnVucylcbiAgICAgICAgLnNldCh7XG4gICAgICAgICAgc3RhdHVzOiAnY2FuY2VsbGVkJyxcbiAgICAgICAgICBjb21wbGV0ZWRBdDogbm93LFxuICAgICAgICAgIHVwZGF0ZWRBdDogbm93LFxuICAgICAgICB9KVxuICAgICAgICAud2hlcmUoZXEoU2NoZW1hLnJ1bnMucnVuSWQsIHJ1bklkKSk7XG5cbiAgICAgIC8vIERlbGV0ZSBhbGwgaG9va3MgYW5kIHdhaXRzIGZvciB0aGlzIHJ1blxuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBkcml6emxlLmRlbGV0ZShTY2hlbWEuaG9va3MpLndoZXJlKGVxKFNjaGVtYS5ob29rcy5ydW5JZCwgcnVuSWQpKSxcbiAgICAgICAgZHJpenpsZS5kZWxldGUoU2NoZW1hLndhaXRzKS53aGVyZShlcShTY2hlbWEud2FpdHMucnVuSWQsIHJ1bklkKSksXG4gICAgICBdKTtcblxuICAgICAgLy8gRmV0Y2ggdXBkYXRlZCBydW4gZm9yIHJldHVybiB2YWx1ZVxuICAgICAgY29uc3QgW3VwZGF0ZWRSdW5dID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAuc2VsZWN0KClcbiAgICAgICAgLmZyb20oU2NoZW1hLnJ1bnMpXG4gICAgICAgIC53aGVyZShlcShTY2hlbWEucnVucy5ydW5JZCwgcnVuSWQpKVxuICAgICAgICAubGltaXQoMSk7XG5cbiAgICAgIC8vIFJldHVybiB3aXRob3V0IGV2ZW50IChsZWdhY3kgYmVoYXZpb3Igc2tpcHMgZXZlbnQgc3RvcmFnZSlcbiAgICAgIC8vIFR5cGUgYXNzZXJ0aW9uOiBFdmVudFJlc3VsdCBleHBlY3RzIFdvcmtmbG93UnVuLCBmaWx0ZXJSdW5EYXRhIG1heSByZXR1cm4gV29ya2Zsb3dSdW5XaXRob3V0RGF0YVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcnVuOiB1cGRhdGVkUnVuXG4gICAgICAgICAgPyAoZmlsdGVyUnVuRGF0YShcbiAgICAgICAgICAgICAgZGVzZXJpYWxpemVSdW5FcnJvcihjb21wYWN0KHVwZGF0ZWRSdW4pKSxcbiAgICAgICAgICAgICAgcmVzb2x2ZURhdGFcbiAgICAgICAgICAgICkgYXMgV29ya2Zsb3dSdW4pXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNhc2UgJ3dhaXRfY29tcGxldGVkJzpcbiAgICBjYXNlICdob29rX3JlY2VpdmVkJzoge1xuICAgICAgLy8gTGVnYWN5OiBTdG9yZSBldmVudCBvbmx5IChubyBlbnRpdHkgbXV0YXRpb24pXG4gICAgICAvLyAtIHdhaXRfY29tcGxldGVkOiBmb3IgcmVwbGF5IHB1cnBvc2VzXG4gICAgICAvLyAtIGhvb2tfcmVjZWl2ZWQ6IGhvb2tzIGV4aXN0IHZpYSBvbGQgc3lzdGVtLCBqdXN0IHJlY29yZCB0aGUgZXZlbnRcbiAgICAgIC8vXG4gICAgICAvLyBob29rX3JlY2VpdmVkIGFkZGl0aW9uYWxseSBndWFyZHMgYWdhaW5zdCBhIGNvbmN1cnJlbnQgKG9yIGFscmVhZHlcbiAgICAgIC8vIGNvbW1pdHRlZCkgdGVybWluYWwgdHJhbnNpdGlvbiwgbWlycm9yaW5nIHRoZSBjdXJyZW50LXNwZWNcbiAgICAgIC8vIGhvb2tfcmVjZWl2ZWQgdHJhbnNhY3Rpb24gYmVsb3c6IGBGT1IgVVBEQVRFYCB0YWtlcyB0aGUgcnVuIHJvd1xuICAgICAgLy8gbG9jaywgYmxvY2tpbmcgdW50aWwgYW55IGluLWZsaWdodCB0ZXJtaW5hbCBVUERBVEUgKGluY2x1ZGluZyB0aGVcbiAgICAgIC8vIGxlZ2FjeSBydW5fY2FuY2VsbGVkIHBhdGggYWJvdmUpIGNvbW1pdHMsIHRoZW4gb2JzZXJ2ZXMgdGhlXG4gICAgICAvLyBwb3N0LWNvbW1pdCBzdGF0dXMuXG4gICAgICBjb25zdCBpbnNlcnRMZWdhY3lFdmVudCA9ICh0eDogUGljazxEcml6emxlLCAnaW5zZXJ0Jz4pID0+XG4gICAgICAgIHR4XG4gICAgICAgICAgLmluc2VydChTY2hlbWEuZXZlbnRzKVxuICAgICAgICAgIC52YWx1ZXMoe1xuICAgICAgICAgICAgcnVuSWQsXG4gICAgICAgICAgICBldmVudElkLFxuICAgICAgICAgICAgY29ycmVsYXRpb25JZDogZGF0YS5jb3JyZWxhdGlvbklkLFxuICAgICAgICAgICAgZXZlbnRUeXBlOiBkYXRhLmV2ZW50VHlwZSxcbiAgICAgICAgICAgIGV2ZW50RGF0YTogJ2V2ZW50RGF0YScgaW4gZGF0YSA/IGRhdGEuZXZlbnREYXRhIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgc3BlY1ZlcnNpb246IFNQRUNfVkVSU0lPTl9DVVJSRU5ULFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLnJldHVybmluZyh7IGNyZWF0ZWRBdDogU2NoZW1hLmV2ZW50cy5jcmVhdGVkQXQgfSk7XG5cbiAgICAgIGNvbnN0IFtpbnNlcnRlZEV2ZW50XSA9XG4gICAgICAgIGRhdGEuZXZlbnRUeXBlID09PSAnaG9va19yZWNlaXZlZCdcbiAgICAgICAgICA/IGF3YWl0IGRyaXp6bGUudHJhbnNhY3Rpb24oYXN5bmMgKHR4KSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IFtydW5Sb3ddID0gYXdhaXQgdHhcbiAgICAgICAgICAgICAgICAuc2VsZWN0KHsgc3RhdHVzOiBTY2hlbWEucnVucy5zdGF0dXMgfSlcbiAgICAgICAgICAgICAgICAuZnJvbShTY2hlbWEucnVucylcbiAgICAgICAgICAgICAgICAud2hlcmUoZXEoU2NoZW1hLnJ1bnMucnVuSWQsIHJ1bklkKSlcbiAgICAgICAgICAgICAgICAuZm9yKCd1cGRhdGUnKVxuICAgICAgICAgICAgICAgIC5saW1pdCgxKTtcbiAgICAgICAgICAgICAgaWYgKCFydW5Sb3cpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dSdW5Ob3RGb3VuZEVycm9yKHJ1bklkKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoaXNUZXJtaW5hbFdvcmtmbG93UnVuU3RhdHVzKHJ1blJvdy5zdGF0dXMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFJ1bkV4cGlyZWRFcnJvcihcbiAgICAgICAgICAgICAgICAgIGBXb3JrZmxvdyBydW4gXCIke3J1bklkfVwiIGlzIGFscmVhZHkgaW4gdGVybWluYWwgc3RhdGUgXCIke3J1blJvdy5zdGF0dXN9XCJgXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gaW5zZXJ0TGVnYWN5RXZlbnQodHgpO1xuICAgICAgICAgICAgfSwgU0xPVF9JTlNFUlRfVFJBTlNBQ1RJT04pXG4gICAgICAgICAgOiBhd2FpdCBpbnNlcnRMZWdhY3lFdmVudChkcml6emxlKTtcblxuICAgICAgY29uc3QgZXZlbnQgPSBFdmVudFNjaGVtYS5wYXJzZSh7XG4gICAgICAgIC4uLmRhdGEsXG4gICAgICAgIC4uLmluc2VydGVkRXZlbnQsXG4gICAgICAgIHJ1bklkLFxuICAgICAgICBldmVudElkLFxuICAgICAgfSk7XG4gICAgICByZXR1cm4geyBldmVudDogc3RyaXBFdmVudERhdGFSZWZzKGV2ZW50LCByZXNvbHZlRGF0YSkgfTtcbiAgICB9XG5cbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgRXZlbnQgdHlwZSAnJHtkYXRhLmV2ZW50VHlwZX0nIG5vdCBzdXBwb3J0ZWQgZm9yIGxlZ2FjeSBydW5zIGAgK1xuICAgICAgICAgIGAoc3BlY1ZlcnNpb246ICR7Y3VycmVudFJ1bi5zcGVjVmVyc2lvbiB8fCAndW5kZWZpbmVkJ30pLiBgICtcbiAgICAgICAgICBgUGxlYXNlIHVwZ3JhZGUgQHdvcmtmbG93IHBhY2thZ2VzLmBcbiAgICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV2ZW50c1N0b3JhZ2UoZHJpenpsZTogRHJpenpsZSk6IFN0b3JhZ2VbJ2V2ZW50cyddIHtcbiAgY29uc3QgaG9va1JldGVudGlvbkxpbWl0TXMgPSBnZXRIb29rUmV0ZW50aW9uTGltaXRNcygpO1xuICBjb25zdCB1bGlkID0gbW9ub3RvbmljRmFjdG9yeSgpO1xuICBjb25zdCB7IGV2ZW50cyB9ID0gU2NoZW1hO1xuICBjb25zdCBvd25lclJ1bklzVGVybWluYWwgPSBkcml6emxlXG4gICAgLnNlbGVjdCh7IHJ1bklkOiBTY2hlbWEucnVucy5ydW5JZCB9KVxuICAgIC5mcm9tKFNjaGVtYS5ydW5zKVxuICAgIC53aGVyZShcbiAgICAgIGFuZChcbiAgICAgICAgZXEoU2NoZW1hLnJ1bnMucnVuSWQsIFNjaGVtYS5ob29rcy5ydW5JZCksXG4gICAgICAgIGluQXJyYXkoU2NoZW1hLnJ1bnMuc3RhdHVzLCBURVJNSU5BTF9XT1JLRkxPV19SVU5fU1RBVFVTRVMpXG4gICAgICApXG4gICAgKTtcbiAgY29uc3QgaG9va1JldGVudGlvbkVuZGVkID0gb3IoXG4gICAgaXNOdWxsKFNjaGVtYS5ob29rcy50b2tlblJldGVudGlvblVudGlsKSxcbiAgICBsdGUoU2NoZW1hLmhvb2tzLnRva2VuUmV0ZW50aW9uVW50aWwsIHNxbGBub3coKWApXG4gICk7XG5cbiAgLy8gUHJlcGFyZWQgc3RhdGVtZW50cyBmb3IgdmFsaWRhdGlvbiBxdWVyaWVzIChwZXJmb3JtYW5jZSBvcHRpbWl6YXRpb24pXG4gIGNvbnN0IGdldFJ1bkZvclZhbGlkYXRpb24gPSBkcml6emxlXG4gICAgLnNlbGVjdCh7XG4gICAgICBzdGF0dXM6IFNjaGVtYS5ydW5zLnN0YXR1cyxcbiAgICAgIHNwZWNWZXJzaW9uOiBTY2hlbWEucnVucy5zcGVjVmVyc2lvbixcbiAgICB9KVxuICAgIC5mcm9tKFNjaGVtYS5ydW5zKVxuICAgIC53aGVyZShlcShTY2hlbWEucnVucy5ydW5JZCwgc3FsLnBsYWNlaG9sZGVyKCdydW5JZCcpKSlcbiAgICAubGltaXQoMSlcbiAgICAucHJlcGFyZSgnZXZlbnRzX2dldF9ydW5fZm9yX3ZhbGlkYXRpb24nKTtcblxuICBjb25zdCBnZXRTdGVwRm9yVmFsaWRhdGlvbiA9IGRyaXp6bGVcbiAgICAuc2VsZWN0KHtcbiAgICAgIHN0YXR1czogU2NoZW1hLnN0ZXBzLnN0YXR1cyxcbiAgICAgIHN0YXJ0ZWRBdDogU2NoZW1hLnN0ZXBzLnN0YXJ0ZWRBdCxcbiAgICAgIHJldHJ5QWZ0ZXI6IFNjaGVtYS5zdGVwcy5yZXRyeUFmdGVyLFxuICAgIH0pXG4gICAgLmZyb20oU2NoZW1hLnN0ZXBzKVxuICAgIC53aGVyZShcbiAgICAgIGFuZChcbiAgICAgICAgZXEoU2NoZW1hLnN0ZXBzLnJ1bklkLCBzcWwucGxhY2Vob2xkZXIoJ3J1bklkJykpLFxuICAgICAgICBlcShTY2hlbWEuc3RlcHMuc3RlcElkLCBzcWwucGxhY2Vob2xkZXIoJ3N0ZXBJZCcpKVxuICAgICAgKVxuICAgIClcbiAgICAubGltaXQoMSlcbiAgICAucHJlcGFyZSgnZXZlbnRzX2dldF9zdGVwX2Zvcl92YWxpZGF0aW9uJyk7XG5cbiAgY29uc3QgZ2V0SG9va0J5VG9rZW4gPSBkcml6emxlXG4gICAgLnNlbGVjdCh7IGhvb2tJZDogU2NoZW1hLmhvb2tzLmhvb2tJZCwgcnVuSWQ6IFNjaGVtYS5ob29rcy5ydW5JZCB9KVxuICAgIC5mcm9tKFNjaGVtYS5ob29rcylcbiAgICAud2hlcmUoXG4gICAgICBhbmQoXG4gICAgICAgIGVxKFNjaGVtYS5ob29rcy50b2tlbiwgc3FsLnBsYWNlaG9sZGVyKCd0b2tlbicpKSxcbiAgICAgICAgb3IoXG4gICAgICAgICAgZ3QoU2NoZW1hLmhvb2tzLnRva2VuUmV0ZW50aW9uVW50aWwsIHNxbGBub3coKWApLFxuICAgICAgICAgIG5vdEV4aXN0cyhvd25lclJ1bklzVGVybWluYWwpXG4gICAgICAgIClcbiAgICAgIClcbiAgICApXG4gICAgLmxpbWl0KDEpXG4gICAgLnByZXBhcmUoJ2V2ZW50c19nZXRfaG9va19ieV90b2tlbicpO1xuXG4gIC8vIFVzZWQgdG8gZGlzdGluZ3Vpc2ggYSByZWFsIHNhbWUtaG9vayBkdXBsaWNhdGUgZnJvbSBhbiBvcnBoYW5lZFxuICAvLyBob29rIHJvdyBsZWZ0IGJlaGluZCBieSBhIHByb2Nlc3MgLyBkYXRhYmFzZSBpbnRlcnJ1cHRpb24gYmV0d2VlblxuICAvLyB0aGUgaG9vayBJTlNFUlQgYW5kIHRoZSBldmVudHMgSU5TRVJUIGJlbG93IChzZWUgdGhlIHJlY292ZXJ5XG4gIC8vIGxvZ2ljIGluIHRoZSBob29rX2NyZWF0ZWQgYnJhbmNoKS5cbiAgY29uc3QgZ2V0SG9va0NyZWF0ZWRFdmVudCA9IGRyaXp6bGVcbiAgICAuc2VsZWN0KHsgZXZlbnRJZDogZXZlbnRzLmV2ZW50SWQgfSlcbiAgICAuZnJvbShldmVudHMpXG4gICAgLndoZXJlKFxuICAgICAgYW5kKFxuICAgICAgICBlcShldmVudHMucnVuSWQsIHNxbC5wbGFjZWhvbGRlcigncnVuSWQnKSksXG4gICAgICAgIGVxKGV2ZW50cy5jb3JyZWxhdGlvbklkLCBzcWwucGxhY2Vob2xkZXIoJ2NvcnJlbGF0aW9uSWQnKSksXG4gICAgICAgIGVxKGV2ZW50cy5ldmVudFR5cGUsIHNxbC5wbGFjZWhvbGRlcignZXZlbnRUeXBlJykpXG4gICAgICApXG4gICAgKVxuICAgIC5saW1pdCgxKVxuICAgIC5wcmVwYXJlKCdldmVudHNfZ2V0X2hvb2tfY3JlYXRlZF9mb3JfcnVuX2NvcnJlbGF0aW9uJyk7XG5cbiAgY29uc3QgZ2V0V2FpdEZvclZhbGlkYXRpb24gPSBkcml6emxlXG4gICAgLnNlbGVjdCh7XG4gICAgICBzdGF0dXM6IFNjaGVtYS53YWl0cy5zdGF0dXMsXG4gICAgfSlcbiAgICAuZnJvbShTY2hlbWEud2FpdHMpXG4gICAgLndoZXJlKGVxKFNjaGVtYS53YWl0cy53YWl0SWQsIHNxbC5wbGFjZWhvbGRlcignd2FpdElkJykpKVxuICAgIC5saW1pdCgxKVxuICAgIC5wcmVwYXJlKCdldmVudHNfZ2V0X3dhaXRfZm9yX3ZhbGlkYXRpb24nKTtcblxuICByZXR1cm4ge1xuICAgIGFzeW5jIGNyZWF0ZShcbiAgICAgIHJ1bklkOiBzdHJpbmcgfCBudWxsLFxuICAgICAgZGF0YTogQW55RXZlbnRSZXF1ZXN0LFxuICAgICAgcGFyYW1zPzogQ3JlYXRlRXZlbnRQYXJhbXNcbiAgICApOiBQcm9taXNlPEV2ZW50UmVzdWx0PiB7XG4gICAgICBpZiAoXG4gICAgICAgIGRhdGEuZXZlbnRUeXBlID09PSAnaG9va19jcmVhdGVkJyAmJlxuICAgICAgICBkYXRhLmV2ZW50RGF0YS50b2tlblJldGVudGlvblVudGlsICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgZGF0YS5ldmVudERhdGEudG9rZW5SZXRlbnRpb25VbnRpbC5nZXRUaW1lKCkgPlxuICAgICAgICAgIERhdGUubm93KCkgKyBob29rUmV0ZW50aW9uTGltaXRNc1xuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3JrZmxvd1dvcmxkRXJyb3IoXG4gICAgICAgICAgYEhvb2sgbWluaW11bSByZXRlbnRpb24gY2Fubm90IGV4Y2VlZCAke2hvb2tSZXRlbnRpb25MaW1pdE1zIC8gREFZX01TfSBkYXlzIGluIHRoZSBQb3N0Z3JlcyBXb3JsZC5gLFxuICAgICAgICAgIHsgc3RhdHVzOiA0MDAgfVxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBUaGUgaWQgdGhpcyBjYWxsJ3MgZXZlbnQgdG9vaywga25vd24gb25seSBvbmNlIGl0cyBpbnNlcnQgaGFzXG4gICAgICAvLyBjb21taXR0ZWQ6IG9uIGEgc2xvdC1udW1iZXJlZCBydW4gdGhlIHBvc2l0aW9uIGlzIGNob3NlbiBpbnNpZGUgdGhlXG4gICAgICAvLyBJTlNFUlQsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVhZCBiZWZvcmUgaXQuXG4gICAgICBsZXQgZXZlbnRJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgLy8gTGF6eSwgYmVjYXVzZSBvbiBhIGxlZ2FjeSBydW4gdGhpcyBtaW50cyBhIFVMSUQgYW5kIG9uIGEgc2xvdCBydW4gaXRcbiAgICAgIC8vIHJlYWRzIHdoaWNoIG9mIHRoZSB0d28gc2NoZW1lcyBhcHBsaWVzLiBFdmVyeSBjYWxsZXIgYmVsb3cgYXdhaXRzIGl0XG4gICAgICAvLyBpbW1lZGlhdGVseSBiZWZvcmUgaXRzIGluc2VydC4gQSBjYWxsZXIgdGhhdCBoYXMgYWxyZWFkeSBmaXhlZCB0aGUgaWRcbiAgICAgIC8vIOKAlCBydW5fY3JlYXRlZCwgd2hpY2ggYWx3YXlzIHRha2VzIHRoZSBmaXJzdCBzbG90IOKAlCBnZXRzIHRoYXQgYmFjay5cbiAgICAgIGNvbnN0IGdldEV2ZW50SWQgPSBhc3luYyAoXG4gICAgICAgIGRiOiBEcml6emxlTGlrZSA9IGRyaXp6bGVcbiAgICAgICk6IFByb21pc2U8c3RyaW5nIHwgU1FMPHN0cmluZz4+ID0+XG4gICAgICAgIGV2ZW50SWQgPz8gKGF3YWl0IGFsbG9jYXRlRXZlbnRJZChkYiwgZWZmZWN0aXZlUnVuSWQpKTtcblxuICAgICAgLy8gRm9yIHJ1bl9jcmVhdGVkIGV2ZW50cywgdXNlIGNsaWVudC1wcm92aWRlZCBydW5JZCBvciBnZW5lcmF0ZSBvbmUgc2VydmVyLXNpZGVcbiAgICAgIGxldCBlZmZlY3RpdmVSdW5JZDogc3RyaW5nO1xuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAncnVuX2NyZWF0ZWQnICYmICghcnVuSWQgfHwgcnVuSWQgPT09ICcnKSkge1xuICAgICAgICBlZmZlY3RpdmVSdW5JZCA9IGB3cnVuXyR7dWxpZCgpfWA7XG4gICAgICB9IGVsc2UgaWYgKCFydW5JZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3J1bklkIGlzIHJlcXVpcmVkIGZvciBub24tcnVuX2NyZWF0ZWQgZXZlbnRzJyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlZmZlY3RpdmVSdW5JZCA9IHJ1bklkO1xuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSBjbGllbnQtcHJvdmlkZWQgcnVuSWQgdGltZXN0YW1wIGlzIHdpdGhpbiBhY2NlcHRhYmxlIHRocmVzaG9sZFxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAncnVuX2NyZWF0ZWQnICYmIHJ1bklkICYmIHJ1bklkICE9PSAnJykge1xuICAgICAgICBjb25zdCB2YWxpZGF0aW9uRXJyb3IgPSB2YWxpZGF0ZVVsaWRUaW1lc3RhbXAoZWZmZWN0aXZlUnVuSWQsICd3cnVuXycpO1xuICAgICAgICBpZiAodmFsaWRhdGlvbkVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93V29ybGRFcnJvcih2YWxpZGF0aW9uRXJyb3IpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIHNwZWNWZXJzaW9uIGlzIGFsd2F5cyBzZW50IGJ5IHRoZSBydW50aW1lLCBidXQgd2UgcHJvdmlkZSBhIGZhbGxiYWNrIGZvciBzYWZldHlcbiAgICAgIGNvbnN0IGVmZmVjdGl2ZVNwZWNWZXJzaW9uID0gZGF0YS5zcGVjVmVyc2lvbiA/PyBTUEVDX1ZFUlNJT05fQ1VSUkVOVDtcblxuICAgICAgLy8gVHJhY2sgZW50aXR5IGNyZWF0ZWQvdXBkYXRlZCBmb3IgRXZlbnRSZXN1bHRcbiAgICAgIGxldCBydW46IFdvcmtmbG93UnVuIHwgdW5kZWZpbmVkO1xuICAgICAgbGV0IHN0ZXA6IFN0ZXAgfCB1bmRlZmluZWQ7XG4gICAgICBsZXQgaG9vazogSG9vayB8IHVuZGVmaW5lZDtcbiAgICAgIGxldCB3YWl0OiBXYWl0IHwgdW5kZWZpbmVkO1xuICAgICAgLy8gTGF6eSBzdGVwIHN0YXJ0OiBzZXQgdHJ1ZSB3aGVuIHRoaXMgc3RlcF9zdGFydGVkIGF0b21pY2FsbHkgY3JlYXRlZFxuICAgICAgLy8gdGhlIHN0ZXAgKHRoZSBjYWxsZXIgd29uIHRoZSBjcmVhdGUtY2xhaW0pLiBTdXJmYWNlZCBvbiBFdmVudFJlc3VsdFxuICAgICAgLy8gYXMgdGhlIHJ1bnRpbWUncyBleGFjdGx5LW9uY2Ugb3duZXJzaGlwIHNpZ25hbC5cbiAgICAgIGxldCBzdGVwQ3JlYXRlZExhemlseSA9IGZhbHNlO1xuICAgICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKTtcblxuICAgICAgLy8gVGVybWluYWwgc3RlcCBzdGF0dXNlcyBmb3IgdXNlIGluIFNRTCBXSEVSRSBjbGF1c2VzIChhdG9taWMgZ3VhcmQpLlxuICAgICAgLy8gTXVzdCBtYXRjaCB0aGUgVmVyY2VsIHdvcmxkJ3MgY29uZGl0aW9uYWwgZXhwcmVzc2lvbnM6XG4gICAgICAvLyAgIG5lKHN0YXR1cywgJ2NvbXBsZXRlZCcpIEFORCBuZShzdGF0dXMsICdmYWlsZWQnKSBBTkQgbmUoc3RhdHVzLCAnY2FuY2VsbGVkJylcbiAgICAgIGNvbnN0IHRlcm1pbmFsU3RlcFN0YXR1c2VzOiAodHlwZW9mIFNjaGVtYS5zdGVwcy5zdGF0dXMuZW51bVZhbHVlcylbbnVtYmVyXVtdID1cbiAgICAgICAgWy4uLlRFUk1JTkFMX1NURVBfU1RBVFVTRVNdO1xuXG4gICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAgIC8vIFZBTElEQVRJT046IFRlcm1pbmFsIHN0YXRlIGFuZCBldmVudCBvcmRlcmluZyBjaGVja3NcbiAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgICAvLyBHZXQgY3VycmVudCBydW4gc3RhdGUgZm9yIHZhbGlkYXRpb24gKGlmIG5vdCBjcmVhdGluZyBhIG5ldyBydW4pXG4gICAgICAvLyBTa2lwIHJ1biB2YWxpZGF0aW9uIGZvciBzdGVwX2NvbXBsZXRlZCBhbmQgc3RlcF9yZXRyeWluZyAtIHRoZXkgb25seSBvcGVyYXRlXG4gICAgICAvLyBvbiBydW5uaW5nIHN0ZXBzLCBhbmQgcnVubmluZyBzdGVwcyBhcmUgYWx3YXlzIGFsbG93ZWQgdG8gbW9kaWZ5IHJlZ2FyZGxlc3NcbiAgICAgIC8vIG9mIHJ1biBzdGF0ZS4gVGhpcyBvcHRpbWl6YXRpb24gc2F2ZXMgZGF0YWJhc2UgcXVlcmllcyBwZXIgc3RlcCBldmVudC5cbiAgICAgIGxldCBjdXJyZW50UnVuOiB7IHN0YXR1czogc3RyaW5nOyBzcGVjVmVyc2lvbjogbnVtYmVyIHwgbnVsbCB9IHwgbnVsbCA9XG4gICAgICAgIG51bGw7XG4gICAgICBjb25zdCBza2lwUnVuVmFsaWRhdGlvbkV2ZW50cyA9IFsnc3RlcF9jb21wbGV0ZWQnLCAnc3RlcF9yZXRyeWluZyddO1xuICAgICAgaWYgKFxuICAgICAgICBkYXRhLmV2ZW50VHlwZSAhPT0gJ3J1bl9jcmVhdGVkJyAmJlxuICAgICAgICAhc2tpcFJ1blZhbGlkYXRpb25FdmVudHMuaW5jbHVkZXMoZGF0YS5ldmVudFR5cGUpXG4gICAgICApIHtcbiAgICAgICAgLy8gVXNlIHByZXBhcmVkIHN0YXRlbWVudCBmb3IgYmV0dGVyIHBlcmZvcm1hbmNlXG4gICAgICAgIGNvbnN0IFtydW5WYWx1ZV0gPSBhd2FpdCBnZXRSdW5Gb3JWYWxpZGF0aW9uLmV4ZWN1dGUoe1xuICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgfSk7XG4gICAgICAgIGN1cnJlbnRSdW4gPSBydW5WYWx1ZSA/PyBudWxsO1xuXG4gICAgICAgIC8vIFJlc2lsaWVudCBzdGFydDogcnVuX3N0YXJ0ZWQgb24gbm9uLWV4aXN0ZW50IHJ1biB3aXRoIGV2ZW50RGF0YVxuICAgICAgICAvLyBjcmVhdGVzIHRoZSBydW4gZmlyc3QsIHNvIHRoZSBxdWV1ZSBjYW4gYm9vdHN0cmFwIGEgcnVuIHRoYXRcbiAgICAgICAgLy8gZmFpbGVkIHRvIGNyZWF0ZSBkdXJpbmcgc3RhcnQoKS5cbiAgICAgICAgaWYgKFxuICAgICAgICAgIGRhdGEuZXZlbnRUeXBlID09PSAncnVuX3N0YXJ0ZWQnICYmXG4gICAgICAgICAgIWN1cnJlbnRSdW4gJiZcbiAgICAgICAgICAnZXZlbnREYXRhJyBpbiBkYXRhICYmXG4gICAgICAgICAgZGF0YS5ldmVudERhdGFcbiAgICAgICAgKSB7XG4gICAgICAgICAgY29uc3QgcnVuSW5wdXREYXRhID0gKGRhdGEgYXMgYW55KS5ldmVudERhdGEgYXMge1xuICAgICAgICAgICAgZGVwbG95bWVudElkPzogc3RyaW5nO1xuICAgICAgICAgICAgd29ya2Zsb3dOYW1lPzogc3RyaW5nO1xuICAgICAgICAgICAgaW5wdXQ/OiBhbnk7XG4gICAgICAgICAgICBleGVjdXRpb25Db250ZXh0PzogUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgICAgIGF0dHJpYnV0ZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgICAgICAgICAgYWxsb3dSZXNlcnZlZEF0dHJpYnV0ZXM/OiB0cnVlO1xuICAgICAgICAgICAgZW5jcnlwdGlvblB1YmxpY0tleT86IHN0cmluZztcbiAgICAgICAgICB9O1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHJ1bklucHV0RGF0YS5kZXBsb3ltZW50SWQgJiZcbiAgICAgICAgICAgIHJ1bklucHV0RGF0YS53b3JrZmxvd05hbWUgJiZcbiAgICAgICAgICAgIHJ1bklucHV0RGF0YS5pbnB1dCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB2YWxpZGF0ZUF0dHJpYnV0ZUNoYW5nZXMoXG4gICAgICAgICAgICAgIE9iamVjdC5lbnRyaWVzKHJ1bklucHV0RGF0YS5hdHRyaWJ1dGVzID8/IHt9KS5tYXAoXG4gICAgICAgICAgICAgICAgKFtrZXksIHZhbHVlXSkgPT4gKHsga2V5LCB2YWx1ZSB9KVxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgYWxsb3dSZXNlcnZlZEF0dHJpYnV0ZXM6XG4gICAgICAgICAgICAgICAgICBydW5JbnB1dERhdGEuYWxsb3dSZXNlcnZlZEF0dHJpYnV0ZXMgPT09IHRydWUsXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICAvLyBDcmVhdGUgcnVuICsgcnVuX2NyZWF0ZWQgZXZlbnQgYXRvbWljYWxseS4gVGhlXG4gICAgICAgICAgICAvLyB0cmFuc2FjdGlvbiBlbnN1cmVzIHdlIG5ldmVyIGhhdmUgYW4gb3JwaGFuZWQgcnVuXG4gICAgICAgICAgICAvLyB3aXRob3V0IGl0cyBydW5fY3JlYXRlZCBldmVudC5cbiAgICAgICAgICAgIGNvbnN0IFtpbnNlcnRlZF0gPSBhd2FpdCBkcml6emxlXG4gICAgICAgICAgICAgIC5pbnNlcnQoU2NoZW1hLnJ1bnMpXG4gICAgICAgICAgICAgIC52YWx1ZXMoe1xuICAgICAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgICAgICBkZXBsb3ltZW50SWQ6IHJ1bklucHV0RGF0YS5kZXBsb3ltZW50SWQsXG4gICAgICAgICAgICAgICAgd29ya2Zsb3dOYW1lOiBydW5JbnB1dERhdGEud29ya2Zsb3dOYW1lLFxuICAgICAgICAgICAgICAgIHNwZWNWZXJzaW9uOiBlZmZlY3RpdmVTcGVjVmVyc2lvbixcbiAgICAgICAgICAgICAgICBpbnB1dDogcnVuSW5wdXREYXRhLmlucHV0IGFzIFNlcmlhbGl6ZWRDb250ZW50LFxuICAgICAgICAgICAgICAgIGV4ZWN1dGlvbkNvbnRleHQ6IHJ1bklucHV0RGF0YS5leGVjdXRpb25Db250ZXh0IGFzXG4gICAgICAgICAgICAgICAgICB8IFNlcmlhbGl6ZWRDb250ZW50XG4gICAgICAgICAgICAgICAgICB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICBhdHRyaWJ1dGVzOiBydW5JbnB1dERhdGEuYXR0cmlidXRlcyxcbiAgICAgICAgICAgICAgICAvLyBNdXN0IGJlIG1pcnJvcmVkIGhlcmUgdG9vOiB0aGlzIGlzIHRoZSBwYXRoIHRoYXQgcmVjcmVhdGVzIGFcbiAgICAgICAgICAgICAgICAvLyBydW4gZnJvbSB0aGUgcXVldWVkIG1lc3NhZ2UsIHdoaWNoIGlzIGV4YWN0bHkgd2hlbiB0aGUga2V5XG4gICAgICAgICAgICAgICAgLy8gd291bGQgb3RoZXJ3aXNlIGJlIGxvc3QgZm9yIHRoZSByZXN0IG9mIHRoZSBydW4ncyBsaWZlLlxuICAgICAgICAgICAgICAgIGVuY3J5cHRpb25QdWJsaWNLZXk6IHJ1bklucHV0RGF0YS5lbmNyeXB0aW9uUHVibGljS2V5LFxuICAgICAgICAgICAgICAgIHN0YXR1czogJ3BlbmRpbmcnLFxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAub25Db25mbGljdERvTm90aGluZygpXG4gICAgICAgICAgICAgIC5yZXR1cm5pbmcoKTtcblxuICAgICAgICAgICAgaWYgKGluc2VydGVkKSB7XG4gICAgICAgICAgICAgIC8vIFRoaXMgc3ludGhldGljIHJ1bl9jcmVhdGVkIGlzIHRoZSBydW4ncyBmaXJzdCBldmVudCwgc28gaXRcbiAgICAgICAgICAgICAgLy8gb3BlbnMgdGhlIHNsb3QgY291bnRlciB0aGUgcmVzdCBvZiB0aGUgcnVuIGFsbG9jYXRlcyBmcm9tLlxuICAgICAgICAgICAgICBjb25zdCBydW5DcmVhdGVkRXZlbnRJZCA9IGF3YWl0IG9wZW5FdmVudFNsb3RzKFxuICAgICAgICAgICAgICAgIGRyaXp6bGUsXG4gICAgICAgICAgICAgICAgZWZmZWN0aXZlUnVuSWRcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgYXdhaXQgZHJpenpsZS5pbnNlcnQoZXZlbnRzKS52YWx1ZXMoe1xuICAgICAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgICAgICBldmVudElkOiBydW5DcmVhdGVkRXZlbnRJZCxcbiAgICAgICAgICAgICAgICBldmVudFR5cGU6ICdydW5fY3JlYXRlZCcsXG4gICAgICAgICAgICAgICAgZXZlbnREYXRhOiB7XG4gICAgICAgICAgICAgICAgICBkZXBsb3ltZW50SWQ6IHJ1bklucHV0RGF0YS5kZXBsb3ltZW50SWQsXG4gICAgICAgICAgICAgICAgICB3b3JrZmxvd05hbWU6IHJ1bklucHV0RGF0YS53b3JrZmxvd05hbWUsXG4gICAgICAgICAgICAgICAgICBpbnB1dDogcnVuSW5wdXREYXRhLmlucHV0LFxuICAgICAgICAgICAgICAgICAgZXhlY3V0aW9uQ29udGV4dDogcnVuSW5wdXREYXRhLmV4ZWN1dGlvbkNvbnRleHQsXG4gICAgICAgICAgICAgICAgICBhdHRyaWJ1dGVzOiBydW5JbnB1dERhdGEuYXR0cmlidXRlcyxcbiAgICAgICAgICAgICAgICAgIGFsbG93UmVzZXJ2ZWRBdHRyaWJ1dGVzOiBydW5JbnB1dERhdGEuYWxsb3dSZXNlcnZlZEF0dHJpYnV0ZXMsXG4gICAgICAgICAgICAgICAgICBlbmNyeXB0aW9uUHVibGljS2V5OiBydW5JbnB1dERhdGEuZW5jcnlwdGlvblB1YmxpY0tleSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHNwZWNWZXJzaW9uOiBlZmZlY3RpdmVTcGVjVmVyc2lvbixcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBjcmVhdGVkUnVuID0gaW5zZXJ0ZWQ7XG5cbiAgICAgICAgICAgIGlmIChjcmVhdGVkUnVuKSB7XG4gICAgICAgICAgICAgIGN1cnJlbnRSdW4gPSB7XG4gICAgICAgICAgICAgICAgc3RhdHVzOiAncGVuZGluZycsXG4gICAgICAgICAgICAgICAgc3BlY1ZlcnNpb246IGVmZmVjdGl2ZVNwZWNWZXJzaW9uLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgLy8gUnVuIGFscmVhZHkgZXhpc3RzIChjb25jdXJyZW50IHJ1bl9jcmVhdGVkIHdvbiB0aGVcbiAgICAgICAgICAgICAgLy8gcmFjZSkuIFJlLXJlYWQgc28gZG93bnN0cmVhbSBsb2dpYyBzZWVzIHRoZSByZWFsIHN0YXRlLlxuICAgICAgICAgICAgICBjb25zdCBbcnVuVmFsdWVdID0gYXdhaXQgZ2V0UnVuRm9yVmFsaWRhdGlvbi5leGVjdXRlKHtcbiAgICAgICAgICAgICAgICBydW5JZDogZWZmZWN0aXZlUnVuSWQsXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBjdXJyZW50UnVuID0gcnVuVmFsdWUgPz8gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgICAvLyBWRVJTSU9OIENPTVBBVElCSUxJVFk6IENoZWNrIHJ1biBzcGVjIHZlcnNpb25cbiAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgLy8gRm9yIGV2ZW50cyB0aGF0IGhhdmUgZmV0Y2hlZCB0aGUgcnVuLCBjaGVjayB2ZXJzaW9uIGNvbXBhdGliaWxpdHkuXG4gICAgICAvLyBTa2lwIGZvciBydW5fY3JlYXRlZCAobm8gZXhpc3RpbmcgcnVuKSBhbmQgcnVudGltZSBldmVudHMgKHN0ZXBfY29tcGxldGVkLCBzdGVwX3JldHJ5aW5nKS5cbiAgICAgIGlmIChjdXJyZW50UnVuKSB7XG4gICAgICAgIC8vIENoZWNrIGlmIHJ1biByZXF1aXJlcyBhIG5ld2VyIHdvcmxkIHZlcnNpb25cbiAgICAgICAgaWYgKHJlcXVpcmVzTmV3ZXJXb3JsZChjdXJyZW50UnVuLnNwZWNWZXJzaW9uKSkge1xuICAgICAgICAgIHRocm93IG5ldyBSdW5Ob3RTdXBwb3J0ZWRFcnJvcihcbiAgICAgICAgICAgIGN1cnJlbnRSdW4uc3BlY1ZlcnNpb24hLFxuICAgICAgICAgICAgU1BFQ19WRVJTSU9OX0NVUlJFTlRcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUm91dGUgdG8gbGVnYWN5IGhhbmRsZXIgZm9yIHByZS1ldmVudC1zb3VyY2luZyBydW5zLiBBIHJ1biB0aGlzIG9sZFxuICAgICAgICAvLyBpcyBVTElELW51bWJlcmVkIGJ5IGRlZmluaXRpb24sIHNvIHRoZSBpZCBpcyBtaW50ZWQgaGVyZSByYXRoZXIgdGhhblxuICAgICAgICAvLyByZWFkIG91dCBvZiBhIHNsb3QgbWFya2VyIHRoZSBydW4gY2Fubm90IGhhdmUuXG4gICAgICAgIGlmIChpc0xlZ2FjeVNwZWNWZXJzaW9uKGN1cnJlbnRSdW4uc3BlY1ZlcnNpb24pKSB7XG4gICAgICAgICAgcmV0dXJuIGhhbmRsZUxlZ2FjeUV2ZW50UG9zdGdyZXMoXG4gICAgICAgICAgICBkcml6emxlLFxuICAgICAgICAgICAgZWZmZWN0aXZlUnVuSWQsXG4gICAgICAgICAgICBgd2V2dF8ke2xlZ2FjeUV2ZW50VWxpZCgpfWAsXG4gICAgICAgICAgICBkYXRhLFxuICAgICAgICAgICAgY3VycmVudFJ1bixcbiAgICAgICAgICAgIHBhcmFtc1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgIWN1cnJlbnRSdW4gJiZcbiAgICAgICAgKGRhdGEuZXZlbnRUeXBlID09PSAnYXR0cl9zZXQnIHx8IGRhdGEuZXZlbnRUeXBlID09PSAncnVuX3N0YXJ0ZWQnKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3IoZWZmZWN0aXZlUnVuSWQpO1xuICAgICAgfVxuXG4gICAgICAvLyBMYXp5IHN0ZXAgc3RhcnQ6IGEgc3RlcF9zdGFydGVkIGNhcnJ5aW5nIHN0ZXAtY3JlYXRpb24gZGF0YVxuICAgICAgLy8gKHN0ZXBOYW1lICsgaW5wdXQpIG1heSBhcnJpdmUgd2l0aCBubyBwcmlvciBzdGVwX2NyZWF0ZWQg4oCUIGl0IGNyZWF0ZXNcbiAgICAgIC8vIHRoZSBzdGVwIG9uIHRoZSBmbHkgKHNlZSB0aGUgbWF0ZXJpYWxpemF0aW9uIGJsb2NrIGJlbG93KS4gVGhpc1xuICAgICAgLy8gbWlycm9ycyB0aGUgcmVzaWxpZW50IHJ1bl9zdGFydGVkIHBhdGguIERldGVjdCBpdCBoZXJlIHNvIHRoZVxuICAgICAgLy8gZW50aXR5LWNyZWF0aW9uIHRlcm1pbmFsLXJ1biBndWFyZCB0cmVhdHMgaXQgbGlrZSBhIGNyZWF0aW9uIGFuZCB0aGVcbiAgICAgIC8vIFwic3RlcCBtdXN0IGV4aXN0XCIgb3JkZXJpbmcgZ3VhcmQgYmVsb3cgZG9lc24ndCByZWplY3QgaXQuXG4gICAgICBjb25zdCBjcmVhdGVzQ2hpbGRFbnRpdHkgPSBpc0NoaWxkRW50aXR5Q3JlYXRpb25FdmVudChkYXRhKTtcbiAgICAgIGNvbnN0IGxhenlTdGVwU3RhcnQgPVxuICAgICAgICBjcmVhdGVzQ2hpbGRFbnRpdHkgJiYgZGF0YS5ldmVudFR5cGUgPT09ICdzdGVwX3N0YXJ0ZWQnO1xuXG4gICAgICAvLyBSdW4gdGVybWluYWwgc3RhdGUgdmFsaWRhdGlvblxuICAgICAgaWYgKGN1cnJlbnRSdW4gJiYgaXNUZXJtaW5hbFdvcmtmbG93UnVuU3RhdHVzKGN1cnJlbnRSdW4uc3RhdHVzKSkge1xuICAgICAgICAvLyBJZGVtcG90ZW50IG9wZXJhdGlvbjogcnVuX2NhbmNlbGxlZCBvbiBhbHJlYWR5IGNhbmNlbGxlZCBydW4gaXMgYWxsb3dlZFxuICAgICAgICBpZiAoXG4gICAgICAgICAgZGF0YS5ldmVudFR5cGUgPT09ICdydW5fY2FuY2VsbGVkJyAmJlxuICAgICAgICAgIGN1cnJlbnRSdW4uc3RhdHVzID09PSAnY2FuY2VsbGVkJ1xuICAgICAgICApIHtcbiAgICAgICAgICAvLyBHZXQgZnVsbCBydW4gZm9yIHJldHVybiB2YWx1ZVxuICAgICAgICAgIGNvbnN0IFtmdWxsUnVuXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAgIC5zZWxlY3QoKVxuICAgICAgICAgICAgLmZyb20oU2NoZW1hLnJ1bnMpXG4gICAgICAgICAgICAud2hlcmUoZXEoU2NoZW1hLnJ1bnMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSlcbiAgICAgICAgICAgIC5saW1pdCgxKTtcblxuICAgICAgICAgIC8vIENyZWF0ZSB0aGUgZXZlbnQgKHN0aWxsIHJlY29yZCBpdClcbiAgICAgICAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IGluc2VydEV2ZW50Um93KGRyaXp6bGUsIHtcbiAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgIGV2ZW50SWQ6IGF3YWl0IGdldEV2ZW50SWQoKSxcbiAgICAgICAgICAgIGNvcnJlbGF0aW9uSWQ6IGRhdGEuY29ycmVsYXRpb25JZCxcbiAgICAgICAgICAgIGV2ZW50VHlwZTogZGF0YS5ldmVudFR5cGUsXG4gICAgICAgICAgICBldmVudERhdGE6ICdldmVudERhdGEnIGluIGRhdGEgPyBkYXRhLmV2ZW50RGF0YSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHNwZWNWZXJzaW9uOiBlZmZlY3RpdmVTcGVjVmVyc2lvbixcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGlmICghdmFsdWUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgICAgICBgcnVuX2NhbmNlbGxlZCBmb3IgcnVuIFwiJHtlZmZlY3RpdmVSdW5JZH1cIiBjb3VsZCBub3QgYmUgY3JlYXRlZGBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHtcbiAgICAgICAgICAgIC4uLmRhdGEsXG4gICAgICAgICAgICAuLi52YWx1ZSxcbiAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IEV2ZW50U2NoZW1hLnBhcnNlKHJlc3VsdCk7XG4gICAgICAgICAgY29uc3QgcmVzb2x2ZURhdGEgPSBwYXJhbXM/LnJlc29sdmVEYXRhID8/ICdhbGwnO1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBldmVudDogc3RyaXBFdmVudERhdGFSZWZzKHBhcnNlZCwgcmVzb2x2ZURhdGEpLFxuICAgICAgICAgICAgcnVuOiBmdWxsUnVuID8gZGVzZXJpYWxpemVSdW5FcnJvcihjb21wYWN0KGZ1bGxSdW4pKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRm9yIHJ1bl9zdGFydGVkIG9uIHRlcm1pbmFsIHJ1bnMsIHVzZSBSdW5FeHBpcmVkRXJyb3Igc28gdGhlXG4gICAgICAgIC8vIHJ1bnRpbWUga25vd3MgdG8gZXhpdCB3aXRob3V0IHJldHJ5aW5nLlxuICAgICAgICBpZiAoZGF0YS5ldmVudFR5cGUgPT09ICdydW5fc3RhcnRlZCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUnVuRXhwaXJlZEVycm9yKFxuICAgICAgICAgICAgYFdvcmtmbG93IHJ1biBcIiR7ZWZmZWN0aXZlUnVuSWR9XCIgaXMgYWxyZWFkeSBpbiB0ZXJtaW5hbCBzdGF0ZSBcIiR7Y3VycmVudFJ1bi5zdGF0dXN9XCJgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIE90aGVyIHJ1biBzdGF0ZSB0cmFuc2l0aW9ucyBhcmUgbm90IGFsbG93ZWQgb24gdGVybWluYWwgcnVuc1xuICAgICAgICBpZiAoaXNUZXJtaW5hbFJ1bkV2ZW50VHlwZShkYXRhLmV2ZW50VHlwZSkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgIGBDYW5ub3QgdHJhbnNpdGlvbiBydW4gZnJvbSB0ZXJtaW5hbCBzdGF0ZSBcIiR7Y3VycmVudFJ1bi5zdGF0dXN9XCJgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0aW5nIG5ldyBlbnRpdGllcyBvbiB0ZXJtaW5hbCBydW5zIGlzIG5vdCBhbGxvd2VkLiBBIGxhenlcbiAgICAgICAgLy8gc3RlcF9zdGFydGVkIGNyZWF0ZXMgYSBzdGVwLCBzbyBpdCBpcyByZWplY3RlZCBoZXJlIHRvbyDigJQgYSBiYXJlXG4gICAgICAgIC8vIChub24tbGF6eSkgc3RlcF9zdGFydGVkIGZhbGxzIHRocm91Z2ggdG8gdGhlIHN0ZXAtdmFsaWRhdGlvbiBibG9ja1xuICAgICAgICAvLyBiZWxvdywgd2hpY2ggdXNlcyBSdW5FeHBpcmVkRXJyb3IgZm9yIHRlcm1pbmFsIHJ1bnMuXG4gICAgICAgIGlmIChjcmVhdGVzQ2hpbGRFbnRpdHkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgIGBDYW5ub3QgY3JlYXRlIG5ldyBlbnRpdGllcyBvbiBydW4gaW4gdGVybWluYWwgc3RhdGUgXCIke2N1cnJlbnRSdW4uc3RhdHVzfVwiYFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZGF0YS5ldmVudFR5cGUgPT09ICdhdHRyX3NldCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgIGBDYW5ub3Qgc2V0IGF0dHJpYnV0ZXMgb24gcnVuIGluIHRlcm1pbmFsIHN0YXRlIFwiJHtjdXJyZW50UnVuLnN0YXR1c31cImBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFN0ZXAtcmVsYXRlZCBldmVudCB2YWxpZGF0aW9uIChvcmRlcmluZyBhbmQgdGVybWluYWwgc3RhdGUpXG4gICAgICAvLyBGZXRjaCBzdGF0dXMgKyBzdGFydGVkQXQgc28gd2UgY2FuIHJldXNlIGZvciBzdGVwX3N0YXJ0ZWQgKGF2b2lkIGRvdWJsZSByZWFkKVxuICAgICAgLy8gU2tpcCB2YWxpZGF0aW9uIGZvciBzdGVwX2NvbXBsZXRlZC9zdGVwX2ZhaWxlZCAtIHVzZSBjb25kaXRpb25hbCBVUERBVEUgaW5zdGVhZFxuICAgICAgbGV0IHZhbGlkYXRlZFN0ZXA6IHtcbiAgICAgICAgc3RhdHVzOiBzdHJpbmc7XG4gICAgICAgIHN0YXJ0ZWRBdDogRGF0ZSB8IG51bGw7XG4gICAgICAgIHJldHJ5QWZ0ZXI6IERhdGUgfCBudWxsO1xuICAgICAgfSB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3Qgc3RlcEV2ZW50c05lZWRpbmdWYWxpZGF0aW9uID0gWydzdGVwX3N0YXJ0ZWQnLCAnc3RlcF9yZXRyeWluZyddO1xuICAgICAgaWYgKFxuICAgICAgICBzdGVwRXZlbnRzTmVlZGluZ1ZhbGlkYXRpb24uaW5jbHVkZXMoZGF0YS5ldmVudFR5cGUpICYmXG4gICAgICAgIGRhdGEuY29ycmVsYXRpb25JZFxuICAgICAgKSB7XG4gICAgICAgIC8vIFVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgZm9yIGJldHRlciBwZXJmb3JtYW5jZVxuICAgICAgICBjb25zdCBbZXhpc3RpbmdTdGVwXSA9IGF3YWl0IGdldFN0ZXBGb3JWYWxpZGF0aW9uLmV4ZWN1dGUoe1xuICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICBzdGVwSWQ6IGRhdGEuY29ycmVsYXRpb25JZCxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdmFsaWRhdGVkU3RlcCA9IGV4aXN0aW5nU3RlcCA/PyBudWxsO1xuXG4gICAgICAgIC8vIEV2ZW50IG9yZGVyaW5nOiBzdGVwIG11c3QgZXhpc3QgYmVmb3JlIHRoZXNlIGV2ZW50cyDigJQgZXhjZXB0IG9uIHRoZVxuICAgICAgICAvLyBsYXp5LXN0YXJ0IHBhdGgsIHdoZXJlIHN0ZXBfc3RhcnRlZCBjcmVhdGVzIHRoZSBzdGVwIGl0c2VsZi5cbiAgICAgICAgaWYgKCF2YWxpZGF0ZWRTdGVwICYmICFsYXp5U3RlcFN0YXJ0KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93V29ybGRFcnJvcihcbiAgICAgICAgICAgIGBTdGVwIFwiJHtkYXRhLmNvcnJlbGF0aW9uSWR9XCIgbm90IGZvdW5kYFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBMYXp5IHN0YXJ0IGV4YWN0bHktb25jZSBnYXRlOiBhIGxhenkgc3RlcF9zdGFydGVkIGFsd2F5cyBDUkVBVEVTIHRoZVxuICAgICAgICAvLyBzdGVwICh0aGUgb3duZWQtaW5saW5lIHBhdGggb25seSBzZW5kcyBvbmUgZm9yIGEgc3RlcCB3aG9zZVxuICAgICAgICAvLyBzdGVwX2NyZWF0ZWQgaXQgZGVmZXJyZWQpLiBJZiB0aGUgc3RlcCBhbHJlYWR5IGV4aXN0cywgYSBjb25jdXJyZW50XG4gICAgICAgIC8vIGhhbmRsZXIgd29uIHRoZSBjcmVhdGUg4oCUIHRoaXMgY2FsbGVyIGlzIGEgbG9zZXIgYW5kIG11c3Qgbm90IHN0YXJ0IG9yXG4gICAgICAgIC8vIHJ1biB0aGUgc3RlcC4gVGhyb3cgRW50aXR5Q29uZmxpY3RFcnJvciBzbyB0aGUgcnVudGltZSdzIGV4ZWN1dGVTdGVwXG4gICAgICAgIC8vIG1hcHMgaXQgdG8gYHNraXBwZWRgLiBDcml0aWNhbDogdGhlIHN0YXJ0IFVQREFURSBiZWxvdyBwZXJtaXRzXG4gICAgICAgIC8vIHJlLXN0YXJ0aW5nIGEgbm9uLXRlcm1pbmFsIHN0ZXAgKHJldHJpZXMgcmVseSBvbiB0aGF0KSwgc28gd2l0aG91dFxuICAgICAgICAvLyB0aGlzIGdhdGUgYSBsb3NlciB3b3VsZCByZS1zdGFydCBhIHJ1bm5pbmcgc3RlcCBhbmQgcnVuIHRoZSBib2R5IGFcbiAgICAgICAgLy8gc2Vjb25kIHRpbWUuIChBIGNvbmN1cnJlbnQgY3JlYXRlIHRoYXQgbGFuZHMgYWZ0ZXIgdGhpcyByZWFkIGlzIGFsc29cbiAgICAgICAgLy8gY2F1Z2h0IGJ5IHRoZSBvbkNvbmZsaWN0RG9Ob3RoaW5nKCkrcmV0dXJuaW5nKCkgY2xhaW0gYmVsb3cuKVxuICAgICAgICBpZiAobGF6eVN0ZXBTdGFydCAmJiB2YWxpZGF0ZWRTdGVwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVudGl0eUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICBgU3RlcCBcIiR7ZGF0YS5jb3JyZWxhdGlvbklkfVwiIGFscmVhZHkgY3JlYXRlZGBcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gVGVybWluYWwtc3RhdGUgY2hlY2tzIG9ubHkgYXBwbHkgd2hlbiB0aGUgc3RlcCBhbHJlYWR5IGV4aXN0cy5cbiAgICAgICAgLy8gdmFsaWRhdGVkU3RlcCBpcyBudWxsIG9ubHkgb24gdGhlIGxhenktc3RhcnQgcGF0aCAobm8gc3RlcCB5ZXQpLFxuICAgICAgICAvLyB3aGVyZSB0aGVyZSBpcyBub3RoaW5nIHRlcm1pbmFsIHRvIGd1YXJkIGFnYWluc3QuXG4gICAgICAgIGlmICh2YWxpZGF0ZWRTdGVwKSB7XG4gICAgICAgICAgLy8gU3RlcCB0ZXJtaW5hbCBzdGF0ZSB2YWxpZGF0aW9uXG4gICAgICAgICAgaWYgKGlzVGVybWluYWxTdGVwU3RhdHVzKHZhbGlkYXRlZFN0ZXAuc3RhdHVzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVudGl0eUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICAgIGBDYW5ub3QgbW9kaWZ5IHN0ZXAgaW4gdGVybWluYWwgc3RhdGUgXCIke3ZhbGlkYXRlZFN0ZXAuc3RhdHVzfVwiYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBPbiB0ZXJtaW5hbCBydW5zOiBvbmx5IGFsbG93IGNvbXBsZXRpbmcvZmFpbGluZyBpbi1wcm9ncmVzcyBzdGVwc1xuICAgICAgICAgIGlmIChjdXJyZW50UnVuICYmIGlzVGVybWluYWxXb3JrZmxvd1J1blN0YXR1cyhjdXJyZW50UnVuLnN0YXR1cykpIHtcbiAgICAgICAgICAgIGlmICh2YWxpZGF0ZWRTdGVwLnN0YXR1cyAhPT0gJ3J1bm5pbmcnKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBSdW5FeHBpcmVkRXJyb3IoXG4gICAgICAgICAgICAgICAgYENhbm5vdCBtb2RpZnkgbm9uLXJ1bm5pbmcgc3RlcCBvbiBydW4gaW4gdGVybWluYWwgc3RhdGUgXCIke2N1cnJlbnRSdW4uc3RhdHVzfVwiYFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBIb29rLXJlbGF0ZWQgZXZlbnQgdmFsaWRhdGlvbiAoZXhpc3RlbmNlKS5cbiAgICAgIC8vXG4gICAgICAvLyBBbiB1bmxvY2tlZCByZWFkIG91dHNpZGUgYW55IHRyYW5zYWN0aW9uLCBzbyBpdCBzZXR0bGVzIG9ubHkgdGhlIGNhc2VcbiAgICAgIC8vIHdoZXJlIHRoZSBob29rIHdhcyBhbHJlYWR5IGdvbmUgd2hlbiB0aGUgcmVxdWVzdCBhcnJpdmVkLiBJdCBpcyBOT1RcbiAgICAgIC8vIHdoYXQgb3JkZXJzIGEgZGVsaXZlcnkgYWdhaW5zdCBhIGRpc3Bvc2FsOiB0aGUgZGlzcG9zYWwgY2FuIGNvbW1pdCBpblxuICAgICAgLy8gdGhlIGdhcCBiZXR3ZWVuIHRoaXMgcmVhZCBhbmQgdGhlIGFwcGVuZC4gQm90aCB3cml0ZXJzIHRha2UgdGhlIGhvb2snc1xuICAgICAgLy8gcm93IGxvY2sgZm9yIHRoYXQg4oCUIHNlZSB0aGUgYGhvb2tfZGlzcG9zZWRgIGFuZCBgaG9va19yZWNlaXZlZGBcbiAgICAgIC8vIGJyYW5jaGVzIGJlbG93LlxuICAgICAgaWYgKGlzSG9va0V2ZW50UmVxdWlyaW5nRXhpc3RlbmNlKGRhdGEuZXZlbnRUeXBlKSAmJiBkYXRhLmNvcnJlbGF0aW9uSWQpIHtcbiAgICAgICAgY29uc3QgW2V4aXN0aW5nSG9va10gPSBhd2FpdCBkcml6emxlXG4gICAgICAgICAgLnNlbGVjdCh7IGhvb2tJZDogU2NoZW1hLmhvb2tzLmhvb2tJZCB9KVxuICAgICAgICAgIC5mcm9tKFNjaGVtYS5ob29rcylcbiAgICAgICAgICAud2hlcmUoZXEoU2NoZW1hLmhvb2tzLmhvb2tJZCwgZGF0YS5jb3JyZWxhdGlvbklkKSlcbiAgICAgICAgICAubGltaXQoMSk7XG5cbiAgICAgICAgaWYgKCFleGlzdGluZ0hvb2spIHtcbiAgICAgICAgICB0aHJvdyBuZXcgSG9va05vdEZvdW5kRXJyb3IoZGF0YS5jb3JyZWxhdGlvbklkKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAgIC8vIEVudGl0eSBjcmVhdGlvbi91cGRhdGVzIGJhc2VkIG9uIGV2ZW50IHR5cGVcbiAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgICAvLyBIYW5kbGUgcnVuX2NyZWF0ZWQgZXZlbnQ6IGNyZWF0ZSB0aGUgcnVuIGVudGl0eSBhdG9taWNhbGx5XG4gICAgICBpZiAoZGF0YS5ldmVudFR5cGUgPT09ICdydW5fY3JlYXRlZCcpIHtcbiAgICAgICAgY29uc3QgZXZlbnREYXRhID0gKGRhdGEgYXMgYW55KS5ldmVudERhdGEgYXMge1xuICAgICAgICAgIGRlcGxveW1lbnRJZDogc3RyaW5nO1xuICAgICAgICAgIHdvcmtmbG93TmFtZTogc3RyaW5nO1xuICAgICAgICAgIGlucHV0OiBhbnlbXTtcbiAgICAgICAgICBleGVjdXRpb25Db250ZXh0PzogUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICAgICAgICBhdHRyaWJ1dGVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICAgICAgICBhbGxvd1Jlc2VydmVkQXR0cmlidXRlcz86IHRydWU7XG4gICAgICAgICAgZW5jcnlwdGlvblB1YmxpY0tleT86IHN0cmluZztcbiAgICAgICAgfTtcbiAgICAgICAgdmFsaWRhdGVBdHRyaWJ1dGVDaGFuZ2VzKFxuICAgICAgICAgIE9iamVjdC5lbnRyaWVzKGV2ZW50RGF0YS5hdHRyaWJ1dGVzID8/IHt9KS5tYXAoKFtrZXksIHZhbHVlXSkgPT4gKHtcbiAgICAgICAgICAgIGtleSxcbiAgICAgICAgICAgIHZhbHVlLFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhbGxvd1Jlc2VydmVkQXR0cmlidXRlczogZXZlbnREYXRhLmFsbG93UmVzZXJ2ZWRBdHRyaWJ1dGVzID09PSB0cnVlLFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgW3J1blZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAuaW5zZXJ0KFNjaGVtYS5ydW5zKVxuICAgICAgICAgIC52YWx1ZXMoe1xuICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgICAgZGVwbG95bWVudElkOiBldmVudERhdGEuZGVwbG95bWVudElkLFxuICAgICAgICAgICAgd29ya2Zsb3dOYW1lOiBldmVudERhdGEud29ya2Zsb3dOYW1lLFxuICAgICAgICAgICAgLy8gUHJvcGFnYXRlIHNwZWNWZXJzaW9uIGZyb20gdGhlIGV2ZW50IHRvIHRoZSBydW4gZW50aXR5XG4gICAgICAgICAgICBzcGVjVmVyc2lvbjogZWZmZWN0aXZlU3BlY1ZlcnNpb24sXG4gICAgICAgICAgICBpbnB1dDogZXZlbnREYXRhLmlucHV0IGFzIFNlcmlhbGl6ZWRDb250ZW50LFxuICAgICAgICAgICAgZXhlY3V0aW9uQ29udGV4dDogZXZlbnREYXRhLmV4ZWN1dGlvbkNvbnRleHQgYXNcbiAgICAgICAgICAgICAgfCBTZXJpYWxpemVkQ29udGVudFxuICAgICAgICAgICAgICB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIGF0dHJpYnV0ZXM6IGV2ZW50RGF0YS5hdHRyaWJ1dGVzLFxuICAgICAgICAgICAgZW5jcnlwdGlvblB1YmxpY0tleTogZXZlbnREYXRhLmVuY3J5cHRpb25QdWJsaWNLZXksXG4gICAgICAgICAgICBzdGF0dXM6ICdwZW5kaW5nJyxcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5vbkNvbmZsaWN0RG9Ob3RoaW5nKClcbiAgICAgICAgICAucmV0dXJuaW5nKCk7XG4gICAgICAgIC8vIE5vIHJvdyBiYWNrIG1lYW5zIHRoZSBydW4gYWxyZWFkeSBleGlzdHM6IHRoZSByZXNpbGllbnQgc3RhcnQgcGF0aFxuICAgICAgICAvLyAocnVuX3N0YXJ0ZWQgb24gYSBub24tZXhpc3RlbnQgcnVuKSB3b24gYSBUT0NUT1UgcmFjZSBhbmQgY3JlYXRlZFxuICAgICAgICAvLyBpdC4gU3VyZmFjZSB0aGUgY29uZmxpY3QgcmF0aGVyIHRoYW4gcmV0dXJuaW5nIGB7IHJ1bjogdW5kZWZpbmVkIH1gXG4gICAgICAgIC8vIOKAlCBzdGFydCgpIGFscmVhZHkgdHJlYXRzIEVudGl0eUNvbmZsaWN0RXJyb3IgYXMgYmVuaWduLCBhbmQgZmFsbGluZ1xuICAgICAgICAvLyB0aHJvdWdoIHdvdWxkIGFwcGVuZCBhIGR1cGxpY2F0ZSBydW5fY3JlYXRlZCBldmVudCB0byB0aGUgbG9nLlxuICAgICAgICBpZiAoIXJ1blZhbHVlKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVudGl0eUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICBgV29ya2Zsb3cgcnVuIFwiJHtlZmZlY3RpdmVSdW5JZH1cIiBhbHJlYWR5IGV4aXN0c2BcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIE9wZW4gdGhlIHJ1bidzIHNsb3QgY291bnRlci4gRG9pbmcgaXQgaGVyZSwgcmF0aGVyIHRoYW4gbGF6aWx5IG9uXG4gICAgICAgIC8vIGZpcnN0IGFsbG9jYXRpb24sIGlzIHdoYXQgbWFrZXMgXCJubyByb3dcIiBtZWFuIFwiY3JlYXRlZCBiZWZvcmUgc2xvdHNcbiAgICAgICAgLy8gZXhpc3RlZFwiIGZvciB0aGUgcmVzdCBvZiB0aGUgcnVuJ3MgbGlmZS5cbiAgICAgICAgZXZlbnRJZCA9IGF3YWl0IG9wZW5FdmVudFNsb3RzKGRyaXp6bGUsIGVmZmVjdGl2ZVJ1bklkKTtcbiAgICAgICAgcnVuID0gZGVzZXJpYWxpemVSdW5FcnJvcihjb21wYWN0KHJ1blZhbHVlKSk7XG4gICAgICB9XG5cbiAgICAgIC8vIEhhbmRsZSBydW5fc3RhcnRlZCBldmVudDogdXBkYXRlIHJ1biBzdGF0dXNcbiAgICAgIGlmIChkYXRhLmV2ZW50VHlwZSA9PT0gJ3J1bl9zdGFydGVkJykge1xuICAgICAgICAvLyBJZiB0aGUgcnVuIGlzIGFscmVhZHkgcnVubmluZywgcmV0dXJuIGl0IHdpdGhvdXQgaW5zZXJ0aW5nIGFcbiAgICAgICAgLy8gZHVwbGljYXRlIHJ1bl9zdGFydGVkIGV2ZW50LiAgVGhpcyBtYWtlcyBydW5fc3RhcnRlZCBpZGVtcG90ZW50XG4gICAgICAgIC8vIGZvciBjb25jdXJyZW50IGludm9jYXRpb25zOiByZXBsYXkgaXMgZGV0ZXJtaW5pc3RpYywgc28gbGV0dGluZ1xuICAgICAgICAvLyBtdWx0aXBsZSBjYWxsZXJzIHByb2NlZWQgd2l0aCB0aGUgc2FtZSBydW4gaXMgc2FmZS4gIFdlIHNraXBcbiAgICAgICAgLy8gcHJlbG9hZGVkIGV2ZW50cyBoZXJlIGJlY2F1c2UgdGhpcyBpcyBhIHJhcmUgcmFjZS1jb25kaXRpb24gcGF0aFxuICAgICAgICAvLyDigJQgdGhlIHJ1bnRpbWUgZmFsbHMgYmFjayB0byBsb2FkV29ya2Zsb3dSdW5FdmVudHMoKS5cbiAgICAgICAgaWYgKGN1cnJlbnRSdW4/LnN0YXR1cyA9PT0gJ3J1bm5pbmcnKSB7XG4gICAgICAgICAgY29uc3QgW2Z1bGxSdW5dID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgICAgLnNlbGVjdCgpXG4gICAgICAgICAgICAuZnJvbShTY2hlbWEucnVucylcbiAgICAgICAgICAgIC53aGVyZShlcShTY2hlbWEucnVucy5ydW5JZCwgZWZmZWN0aXZlUnVuSWQpKVxuICAgICAgICAgICAgLmxpbWl0KDEpO1xuICAgICAgICAgIGlmIChmdWxsUnVuKSB7XG4gICAgICAgICAgICByZXR1cm4geyBydW46IGRlc2VyaWFsaXplUnVuRXJyb3IoY29tcGFjdChmdWxsUnVuKSkgfTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBbcnVuVmFsdWVdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgIC51cGRhdGUoU2NoZW1hLnJ1bnMpXG4gICAgICAgICAgLnNldCh7XG4gICAgICAgICAgICBzdGF0dXM6ICdydW5uaW5nJyxcbiAgICAgICAgICAgIHN0YXJ0ZWRBdDogbm93LFxuICAgICAgICAgICAgdXBkYXRlZEF0OiBub3csXG4gICAgICAgICAgfSlcbiAgICAgICAgICAud2hlcmUoZXEoU2NoZW1hLnJ1bnMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSlcbiAgICAgICAgICAucmV0dXJuaW5nKCk7XG4gICAgICAgIGlmIChydW5WYWx1ZSkge1xuICAgICAgICAgIHJ1biA9IGRlc2VyaWFsaXplUnVuRXJyb3IoY29tcGFjdChydW5WYWx1ZSkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEhhbmRsZSBydW5fY29tcGxldGVkIGV2ZW50OiB1cGRhdGUgcnVuIHN0YXR1c1xuICAgICAgLy8gVXNlcyBjb25kaXRpb25hbCBVUERBVEUgdG8gcHJldmVudCBjb21wbGV0aW5nIGFuIGFscmVhZHktdGVybWluYWwgcnVuLlxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAncnVuX2NvbXBsZXRlZCcpIHtcbiAgICAgICAgY29uc3QgZXZlbnREYXRhID0gKGRhdGEgYXMgYW55KS5ldmVudERhdGEgYXMgeyBvdXRwdXQ/OiBhbnkgfTtcbiAgICAgICAgY29uc3QgW3J1blZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAudXBkYXRlKFNjaGVtYS5ydW5zKVxuICAgICAgICAgIC5zZXQoe1xuICAgICAgICAgICAgc3RhdHVzOiAnY29tcGxldGVkJyxcbiAgICAgICAgICAgIG91dHB1dDogZXZlbnREYXRhLm91dHB1dCBhcyBTZXJpYWxpemVkQ29udGVudCB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIGNvbXBsZXRlZEF0OiBub3csXG4gICAgICAgICAgICB1cGRhdGVkQXQ6IG5vdyxcbiAgICAgICAgICB9KVxuICAgICAgICAgIC53aGVyZShcbiAgICAgICAgICAgIGFuZChcbiAgICAgICAgICAgICAgZXEoU2NoZW1hLnJ1bnMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSxcbiAgICAgICAgICAgICAgbm90SW5BcnJheShTY2hlbWEucnVucy5zdGF0dXMsIFRFUk1JTkFMX1dPUktGTE9XX1JVTl9TVEFUVVNFUylcbiAgICAgICAgICAgIClcbiAgICAgICAgICApXG4gICAgICAgICAgLnJldHVybmluZygpO1xuICAgICAgICBpZiAocnVuVmFsdWUpIHtcbiAgICAgICAgICBydW4gPSBkZXNlcmlhbGl6ZVJ1bkVycm9yKGNvbXBhY3QocnVuVmFsdWUpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBbZXhpc3RpbmddID0gYXdhaXQgZ2V0UnVuRm9yVmFsaWRhdGlvbi5leGVjdXRlKHtcbiAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dSdW5Ob3RGb3VuZEVycm9yKGVmZmVjdGl2ZVJ1bklkKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGlzVGVybWluYWxXb3JrZmxvd1J1blN0YXR1cyhleGlzdGluZy5zdGF0dXMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgICAgYENhbm5vdCB0cmFuc2l0aW9uIHJ1biBmcm9tIHRlcm1pbmFsIHN0YXRlIFwiJHtleGlzdGluZy5zdGF0dXN9XCJgXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBIYW5kbGUgcnVuX2ZhaWxlZCBldmVudDogdXBkYXRlIHJ1biBzdGF0dXNcbiAgICAgIC8vIFVzZXMgY29uZGl0aW9uYWwgVVBEQVRFIHRvIHByZXZlbnQgZmFpbGluZyBhbiBhbHJlYWR5LXRlcm1pbmFsIHJ1bi5cbiAgICAgIGlmIChkYXRhLmV2ZW50VHlwZSA9PT0gJ3J1bl9mYWlsZWQnKSB7XG4gICAgICAgIGNvbnN0IGV2ZW50RGF0YSA9IChkYXRhIGFzIGFueSkuZXZlbnREYXRhIGFzIHtcbiAgICAgICAgICBlcnJvcjogdW5rbm93bjtcbiAgICAgICAgICBlcnJvckNvZGU/OiBzdHJpbmc7XG4gICAgICAgIH07XG4gICAgICAgIC8vIFRoZSBlcnJvciBmaWVsZCBpcyBTZXJpYWxpemVkRGF0YSAoVWludDhBcnJheSkgcHJvZHVjZWQgYnlcbiAgICAgICAgLy8gZGVoeWRyYXRlUnVuRXJyb3IuIFdlIHN0b3JlIGl0IHZlcmJhdGltIGluIHRoZSBlcnJvcl9jYm9yIGNvbHVtbjtcbiAgICAgICAgLy8gY29uc3VtZXJzIGh5ZHJhdGUgdmlhIGh5ZHJhdGVSdW5FcnJvci5cbiAgICAgICAgY29uc3QgW3J1blZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAudXBkYXRlKFNjaGVtYS5ydW5zKVxuICAgICAgICAgIC5zZXQoe1xuICAgICAgICAgICAgc3RhdHVzOiAnZmFpbGVkJyxcbiAgICAgICAgICAgIGVycm9yOiBldmVudERhdGEuZXJyb3IgYXMgU2VyaWFsaXplZERhdGEsXG4gICAgICAgICAgICBlcnJvckNvZGU6IGV2ZW50RGF0YS5lcnJvckNvZGUsXG4gICAgICAgICAgICBjb21wbGV0ZWRBdDogbm93LFxuICAgICAgICAgICAgdXBkYXRlZEF0OiBub3csXG4gICAgICAgICAgfSlcbiAgICAgICAgICAud2hlcmUoXG4gICAgICAgICAgICBhbmQoXG4gICAgICAgICAgICAgIGVxKFNjaGVtYS5ydW5zLnJ1bklkLCBlZmZlY3RpdmVSdW5JZCksXG4gICAgICAgICAgICAgIG5vdEluQXJyYXkoU2NoZW1hLnJ1bnMuc3RhdHVzLCBURVJNSU5BTF9XT1JLRkxPV19SVU5fU1RBVFVTRVMpXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICAgIC5yZXR1cm5pbmcoKTtcbiAgICAgICAgaWYgKHJ1blZhbHVlKSB7XG4gICAgICAgICAgcnVuID0gZGVzZXJpYWxpemVSdW5FcnJvcihjb21wYWN0KHJ1blZhbHVlKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgW2V4aXN0aW5nXSA9IGF3YWl0IGdldFJ1bkZvclZhbGlkYXRpb24uZXhlY3V0ZSh7XG4gICAgICAgICAgICBydW5JZDogZWZmZWN0aXZlUnVuSWQsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93UnVuTm90Rm91bmRFcnJvcihlZmZlY3RpdmVSdW5JZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChpc1Rlcm1pbmFsV29ya2Zsb3dSdW5TdGF0dXMoZXhpc3Rpbmcuc3RhdHVzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVudGl0eUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICAgIGBDYW5ub3QgdHJhbnNpdGlvbiBydW4gZnJvbSB0ZXJtaW5hbCBzdGF0ZSBcIiR7ZXhpc3Rpbmcuc3RhdHVzfVwiYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSGFuZGxlIHJ1bl9jYW5jZWxsZWQgZXZlbnQ6IHVwZGF0ZSBydW4gc3RhdHVzXG4gICAgICAvLyBVc2VzIGNvbmRpdGlvbmFsIFVQREFURSB0byBwcmV2ZW50IGNhbmNlbGxpbmcgYW4gYWxyZWFkeS10ZXJtaW5hbCBydW4uXG4gICAgICAvLyBOb3RlOiBpZGVtcG90ZW50IHJ1bl9jYW5jZWxsZWQgb24gYWxyZWFkeS1jYW5jZWxsZWQgcnVucyBpcyBoYW5kbGVkXG4gICAgICAvLyBlYXJsaWVyIGluIHRoZSBwcmUtdmFsaWRhdGlvbiBibG9jayAoY3JlYXRlcyBldmVudCBhbmQgcmV0dXJucyBlYXJseSkuXG4gICAgICBpZiAoZGF0YS5ldmVudFR5cGUgPT09ICdydW5fY2FuY2VsbGVkJykge1xuICAgICAgICBjb25zdCBbcnVuVmFsdWVdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgIC51cGRhdGUoU2NoZW1hLnJ1bnMpXG4gICAgICAgICAgLnNldCh7XG4gICAgICAgICAgICBzdGF0dXM6ICdjYW5jZWxsZWQnLFxuICAgICAgICAgICAgY29tcGxldGVkQXQ6IG5vdyxcbiAgICAgICAgICAgIHVwZGF0ZWRBdDogbm93LFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLndoZXJlKFxuICAgICAgICAgICAgYW5kKFxuICAgICAgICAgICAgICBlcShTY2hlbWEucnVucy5ydW5JZCwgZWZmZWN0aXZlUnVuSWQpLFxuICAgICAgICAgICAgICBub3RJbkFycmF5KFNjaGVtYS5ydW5zLnN0YXR1cywgVEVSTUlOQUxfV09SS0ZMT1dfUlVOX1NUQVRVU0VTKVxuICAgICAgICAgICAgKVxuICAgICAgICAgIClcbiAgICAgICAgICAucmV0dXJuaW5nKCk7XG4gICAgICAgIGlmIChydW5WYWx1ZSkge1xuICAgICAgICAgIHJ1biA9IGRlc2VyaWFsaXplUnVuRXJyb3IoY29tcGFjdChydW5WYWx1ZSkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IFtleGlzdGluZ10gPSBhd2FpdCBnZXRSdW5Gb3JWYWxpZGF0aW9uLmV4ZWN1dGUoe1xuICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3IoZWZmZWN0aXZlUnVuSWQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoaXNUZXJtaW5hbFdvcmtmbG93UnVuU3RhdHVzKGV4aXN0aW5nLnN0YXR1cykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgICAgICBgQ2Fubm90IHRyYW5zaXRpb24gcnVuIGZyb20gdGVybWluYWwgc3RhdGUgXCIke2V4aXN0aW5nLnN0YXR1c31cImBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChpc1Rlcm1pbmFsUnVuRXZlbnRUeXBlKGRhdGEuZXZlbnRUeXBlKSkge1xuICAgICAgICAvLyBSZXRhaW5lZCBIb29rcyByZW1haW4gdmlzaWJsZSBhZnRlciB0aGUgcnVuIGVuZHMuIE90aGVyIEhvb2tzIGFuZFxuICAgICAgICAvLyBhbGwgd2FpdHMgYXJlIHJlbW92ZWQgaW1tZWRpYXRlbHkuXG4gICAgICAgIGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgICBkcml6emxlXG4gICAgICAgICAgICAuZGVsZXRlKFNjaGVtYS5ob29rcylcbiAgICAgICAgICAgIC53aGVyZShcbiAgICAgICAgICAgICAgYW5kKGVxKFNjaGVtYS5ob29rcy5ydW5JZCwgZWZmZWN0aXZlUnVuSWQpLCBob29rUmV0ZW50aW9uRW5kZWQpXG4gICAgICAgICAgICApLFxuICAgICAgICAgIGRyaXp6bGVcbiAgICAgICAgICAgIC5kZWxldGUoU2NoZW1hLndhaXRzKVxuICAgICAgICAgICAgLndoZXJlKGVxKFNjaGVtYS53YWl0cy5ydW5JZCwgZWZmZWN0aXZlUnVuSWQpKSxcbiAgICAgICAgXSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChkYXRhLmV2ZW50VHlwZSA9PT0gJ2F0dHJfc2V0Jykge1xuICAgICAgICBjb25zdCB7IGNoYW5nZXMsIGFsbG93UmVzZXJ2ZWRBdHRyaWJ1dGVzIH0gPSBkYXRhLmV2ZW50RGF0YTtcbiAgICAgICAgLy8gRGVkdXAgcHJlLWNoZWNrIGZvciBjb3JyZWxhdGVkIHdvcmtmbG93IHdyaXRlczogaWYgdGhlIGV2ZW50IGlzXG4gICAgICAgIC8vIGFscmVhZHkgaW4gdGhlIGxvZyAoYSByZWRlbGl2ZXJlZC9yZXBsYXllZCBkdXBsaWNhdGUpLCByZWplY3RcbiAgICAgICAgLy8gQkVGT1JFIG1hdGVyaWFsaXppbmcgb250byB0aGUgcnVuLiBXaXRob3V0IHRoaXMsIGEgZHVwbGljYXRlIOKAlFxuICAgICAgICAvLyBpbmNsdWRpbmcgYSBwYXRob2xvZ2ljYWwgb25lIGNhcnJ5aW5nIGRpZmZlcmVudCBjaGFuZ2VzIGZvciB0aGVcbiAgICAgICAgLy8gc2FtZSBjb3JyZWxhdGlvbklkIOKAlCB3b3VsZCBtdXRhdGUgYHJ1bi5hdHRyaWJ1dGVzYCBhbmQgdGhlbiBmYWlsXG4gICAgICAgIC8vIHRoZSBldmVudCBpbnNlcnQsIGxlYXZpbmcgdGhlIHNuYXBzaG90IG91dCBvZiBzeW5jIHdpdGggdGhlXG4gICAgICAgIC8vIGV2ZW50IGxvZy4gVGhlIHVuaXF1ZSBpbmRleCBvbiB0aGUgaW5zZXJ0IGJlbG93IHN0aWxsIGd1YXJkcyB0aGVcbiAgICAgICAgLy8gdHJ1bHktY29uY3VycmVudCByYWNlOyBib3RoIHdyaXRlcnMgb2YgdGhhdCByYWNlIGNhcnJ5IGlkZW50aWNhbFxuICAgICAgICAvLyBjaGFuZ2VzIChkZXRlcm1pbmlzdGljIHJlcGxheSksIHNvIHRoZSBkb3VibGUtYXBwbGllZCB1cGRhdGUgaXNcbiAgICAgICAgLy8gaWRlbXBvdGVudCB0aGVyZS5cbiAgICAgICAgaWYgKGRhdGEuY29ycmVsYXRpb25JZCAmJiBkYXRhLmV2ZW50RGF0YS53cml0ZXIudHlwZSA9PT0gJ3dvcmtmbG93Jykge1xuICAgICAgICAgIGNvbnN0IFtkdXBsaWNhdGVdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgICAgLnNlbGVjdCh7IGV2ZW50SWQ6IGV2ZW50cy5ldmVudElkIH0pXG4gICAgICAgICAgICAuZnJvbShldmVudHMpXG4gICAgICAgICAgICAud2hlcmUoXG4gICAgICAgICAgICAgIGFuZChcbiAgICAgICAgICAgICAgICBlcShldmVudHMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSxcbiAgICAgICAgICAgICAgICBlcShldmVudHMuY29ycmVsYXRpb25JZCwgZGF0YS5jb3JyZWxhdGlvbklkKSxcbiAgICAgICAgICAgICAgICBlcShldmVudHMuZXZlbnRUeXBlLCAnYXR0cl9zZXQnKVxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAubGltaXQoMSk7XG4gICAgICAgICAgaWYgKGR1cGxpY2F0ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVudGl0eUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICAgIGBhdHRyX3NldCBmb3IgY29ycmVsYXRpb25JZCBcIiR7ZGF0YS5jb3JyZWxhdGlvbklkfVwiIGFscmVhZHkgZXhpc3RzIGluIHJ1biBcIiR7ZWZmZWN0aXZlUnVuSWR9XCJgXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb25zdCBbZXhpc3RpbmddID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgIC5zZWxlY3QoeyBhdHRyaWJ1dGVzOiBTY2hlbWEucnVucy5hdHRyaWJ1dGVzIH0pXG4gICAgICAgICAgLmZyb20oU2NoZW1hLnJ1bnMpXG4gICAgICAgICAgLndoZXJlKGVxKFNjaGVtYS5ydW5zLnJ1bklkLCBlZmZlY3RpdmVSdW5JZCkpXG4gICAgICAgICAgLmxpbWl0KDEpO1xuICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93UnVuTm90Rm91bmRFcnJvcihlZmZlY3RpdmVSdW5JZCk7XG4gICAgICAgIH1cbiAgICAgICAgdmFsaWRhdGVBdHRyaWJ1dGVDaGFuZ2VzKGNoYW5nZXMsIHtcbiAgICAgICAgICBleGlzdGluZ0tleXM6IE9iamVjdC5rZXlzKGV4aXN0aW5nLmF0dHJpYnV0ZXMgPz8ge30pLFxuICAgICAgICAgIGFsbG93UmVzZXJ2ZWRBdHRyaWJ1dGVzOiBhbGxvd1Jlc2VydmVkQXR0cmlidXRlcyA9PT0gdHJ1ZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IGV4cHIgPSBzcWxgQ09BTEVTQ0UoJHtTY2hlbWEucnVucy5hdHRyaWJ1dGVzfSwgJ3t9Jzo6anNvbmIpYDtcbiAgICAgICAgZm9yIChjb25zdCB7IGtleSwgdmFsdWUgfSBvZiBjaGFuZ2VzKSB7XG4gICAgICAgICAgaWYgKHZhbHVlID09PSBudWxsKSB7XG4gICAgICAgICAgICBleHByID0gc3FsYCR7ZXhwcn0gLSAke2tleX1gO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBleHByID0gc3FsYGpzb25iX3NldCgke2V4cHJ9LCBBUlJBWVske2tleX1dOjp0ZXh0W10sIHRvX2pzb25iKCR7dmFsdWV9Ojp0ZXh0KSwgdHJ1ZSlgO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IFtydW5WYWx1ZV0gPSBhd2FpdCBkcml6emxlXG4gICAgICAgICAgLnVwZGF0ZShTY2hlbWEucnVucylcbiAgICAgICAgICAuc2V0KHtcbiAgICAgICAgICAgIGF0dHJpYnV0ZXM6IGV4cHIgYXMgYW55LFxuICAgICAgICAgICAgdXBkYXRlZEF0OiBub3csXG4gICAgICAgICAgfSlcbiAgICAgICAgICAud2hlcmUoXG4gICAgICAgICAgICBhbmQoXG4gICAgICAgICAgICAgIGVxKFNjaGVtYS5ydW5zLnJ1bklkLCBlZmZlY3RpdmVSdW5JZCksXG4gICAgICAgICAgICAgIHNxbGAoU0VMRUNUIENPVU5UKCopIEZST00ganNvbmJfb2JqZWN0X2tleXMoJHtleHByfSkpIDw9ICR7QVRUUklCVVRFX01BWF9QRVJfUlVOfWBcbiAgICAgICAgICAgIClcbiAgICAgICAgICApXG4gICAgICAgICAgLnJldHVybmluZygpO1xuICAgICAgICBpZiAoIXJ1blZhbHVlKSB7XG4gICAgICAgICAgLy8gVGhlIGd1YXJkZWQgdXBkYXRlIG1hdGNoZXMgemVybyByb3dzIGVpdGhlciBiZWNhdXNlIHRoZSBjYXBcbiAgICAgICAgICAvLyBjb25kaXRpb24gZmFpbGVkIG9yIGJlY2F1c2UgdGhlIHJ1biByb3cgZGlzYXBwZWFyZWQgYmV0d2VlbiB0aGVcbiAgICAgICAgICAvLyBleGlzdGVuY2UgY2hlY2sgYWJvdmUgYW5kIHRoaXMgdXBkYXRlIOKAlCBkaXN0aW5ndWlzaCB0aGUgdHdvIHNvXG4gICAgICAgICAgLy8gdGhlIGVycm9yIGlzIG5vdCBtaXNhdHRyaWJ1dGVkLlxuICAgICAgICAgIGNvbnN0IFtzdGlsbEV4aXN0c10gPSBhd2FpdCBkcml6emxlXG4gICAgICAgICAgICAuc2VsZWN0KHsgcnVuSWQ6IFNjaGVtYS5ydW5zLnJ1bklkIH0pXG4gICAgICAgICAgICAuZnJvbShTY2hlbWEucnVucylcbiAgICAgICAgICAgIC53aGVyZShlcShTY2hlbWEucnVucy5ydW5JZCwgZWZmZWN0aXZlUnVuSWQpKVxuICAgICAgICAgICAgLmxpbWl0KDEpO1xuICAgICAgICAgIGlmICghc3RpbGxFeGlzdHMpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBXb3JrZmxvd1J1bk5vdEZvdW5kRXJyb3IoZWZmZWN0aXZlUnVuSWQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBuZXcgQXR0cmlidXRlVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgYFJ1biBhdHRyaWJ1dGUgY291bnQgd291bGQgZXhjZWVkIGxpbWl0ICR7QVRUUklCVVRFX01BWF9QRVJfUlVOfWBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJ1biA9IGRlc2VyaWFsaXplUnVuRXJyb3IoY29tcGFjdChydW5WYWx1ZSkpO1xuICAgICAgfVxuXG4gICAgICAvLyBTdHJpcCBldmVudERhdGEgZnJvbSBydW5fc3RhcnRlZCDigJQgaXQgYmVsb25ncyBvbiBydW5fY3JlYXRlZCBvbmx5LlxuICAgICAgLy8gRm9yIHN0ZXBfc3RhcnRlZCBvbiB0aGUgbGF6eS1zdGFydCBwYXRoLCBzdHJpcCBvbmx5IHRoZSBzdGVwIGBpbnB1dGBcbiAgICAgIC8vIChpdCBiZWxvbmdzIG9uIHRoZSBzeW50aGV0aWMgc3RlcF9jcmVhdGVkIHdyaXR0ZW4gYmVsb3cpOyBgc3RlcE5hbWVgXG4gICAgICAvLyBpcyBwcmVzZXJ2ZWQgZm9yIHRoZSBjbGllbnQgcmVwbGF5IGNvbnN1bWVyJ3Mgc3RlcC1uYW1lIGRpdmVyZ2VuY2VcbiAgICAgIC8vIGNoZWNrLlxuICAgICAgbGV0IHN0b3JlZEV2ZW50RGF0YTogdW5rbm93bjtcbiAgICAgIGlmIChkYXRhLmV2ZW50VHlwZSA9PT0gJ3J1bl9zdGFydGVkJykge1xuICAgICAgICBzdG9yZWRFdmVudERhdGEgPSB1bmRlZmluZWQ7XG4gICAgICB9IGVsc2UgaWYgKCdldmVudERhdGEnIGluIGRhdGEgJiYgZGF0YS5ldmVudERhdGEpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGRhdGEuZXZlbnRUeXBlID09PSAnc3RlcF9zdGFydGVkJyAmJlxuICAgICAgICAgICdpbnB1dCcgaW4gKGRhdGEuZXZlbnREYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB7IGlucHV0OiBfc3RyaXBwZWRJbnB1dCwgLi4ucmVzdCB9ID0gZGF0YS5ldmVudERhdGEgYXMge1xuICAgICAgICAgICAgaW5wdXQ/OiB1bmtub3duO1xuICAgICAgICAgIH0gJiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICBzdG9yZWRFdmVudERhdGEgPSByZXN0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHN0b3JlZEV2ZW50RGF0YSA9IGRhdGEuZXZlbnREYXRhO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdG9yZWRFdmVudERhdGEgPSB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIC8vIEhhbmRsZSBzdGVwX2NyZWF0ZWQgZXZlbnQ6IGNyZWF0ZSBzdGVwIGVudGl0eVxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAnc3RlcF9jcmVhdGVkJykge1xuICAgICAgICBjb25zdCBldmVudERhdGEgPSAoZGF0YSBhcyBhbnkpLmV2ZW50RGF0YSBhcyB7XG4gICAgICAgICAgc3RlcE5hbWU6IHN0cmluZztcbiAgICAgICAgICBpbnB1dDogYW55O1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCBbc3RlcFZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAuaW5zZXJ0KFNjaGVtYS5zdGVwcylcbiAgICAgICAgICAudmFsdWVzKHtcbiAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgIHN0ZXBJZDogZGF0YS5jb3JyZWxhdGlvbklkISxcbiAgICAgICAgICAgIHN0ZXBOYW1lOiBldmVudERhdGEuc3RlcE5hbWUsXG4gICAgICAgICAgICBpbnB1dDogZXZlbnREYXRhLmlucHV0IGFzIFNlcmlhbGl6ZWRDb250ZW50LFxuICAgICAgICAgICAgc3RhdHVzOiAncGVuZGluZycsXG4gICAgICAgICAgICBhdHRlbXB0OiAwLFxuICAgICAgICAgICAgLy8gUHJvcGFnYXRlIHNwZWNWZXJzaW9uIGZyb20gdGhlIGV2ZW50IHRvIHRoZSBzdGVwIGVudGl0eVxuICAgICAgICAgICAgc3BlY1ZlcnNpb246IGVmZmVjdGl2ZVNwZWNWZXJzaW9uLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLm9uQ29uZmxpY3REb05vdGhpbmcoKVxuICAgICAgICAgIC5yZXR1cm5pbmcoKTtcbiAgICAgICAgaWYgKHN0ZXBWYWx1ZSkge1xuICAgICAgICAgIHN0ZXAgPSBkZXNlcmlhbGl6ZVN0ZXBFcnJvcihjb21wYWN0KHN0ZXBWYWx1ZSkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGxldCB2YWx1ZTogeyBjcmVhdGVkQXQ6IERhdGUgfSB8IHVuZGVmaW5lZDtcblxuICAgICAgLy8gSGFuZGxlIHN0ZXBfc3RhcnRlZCBldmVudDogaW5jcmVtZW50IGF0dGVtcHQgYW5kIHNldCB0aGUgc3RlcCB0b1xuICAgICAgLy8gcnVubmluZywgdGhlbiB3cml0ZSB0aGUgbWF0Y2hpbmcgZXZlbnQgbG9nIGVudHJ5IGluIHRoZSBzYW1lXG4gICAgICAvLyB0cmFuc2FjdGlvbi4gVGhlIGd1YXJkZWQgVVBEQVRFIHRha2VzIHRoZSBzdGVwIHJvdyBsb2NrOyBrZWVwaW5nIHRoZVxuICAgICAgLy8gZXZlbnQgSU5TRVJUIGJlaGluZCB0aGF0IGxvY2sgcHJldmVudHMgYSBsYXRlIHN0ZXBfc3RhcnRlZCBmcm9tIGJlaW5nXG4gICAgICAvLyBvcmRlcmVkIGFmdGVyIGEgY29uY3VycmVudCB0ZXJtaW5hbCBldmVudCB0aGF0IGFscmVhZHkgd29uIHRoZSByb3cuXG4gICAgICBpZiAoZGF0YS5ldmVudFR5cGUgPT09ICdzdGVwX3N0YXJ0ZWQnKSB7XG4gICAgICAgIHZhbHVlID0gYXdhaXQgZHJpenpsZS50cmFuc2FjdGlvbihhc3luYyAodHgpID0+IHtcbiAgICAgICAgICAvLyBMYXp5IHN0ZXAgc3RhcnQ6IG5vIHByaW9yIHN0ZXBfY3JlYXRlZCBleGlzdHMsIGJ1dCB0aGlzXG4gICAgICAgICAgLy8gc3RlcF9zdGFydGVkIGNhcnJpZXMgdGhlIHN0ZXAtY3JlYXRpb24gZGF0YS4gVGhlIHN0ZXAgSU5TRVJUIGlzXG4gICAgICAgICAgLy8gdGhlIG93bmVyc2hpcCBjbGFpbTogb25seSB0aGUgY2FsbGVyIHRoYXQgaW5zZXJ0cyB0aGUgcm93IGdldHMgdG9cbiAgICAgICAgICAvLyBydW4gdGhlIHN0ZXAgYm9keSBpbmxpbmUuXG4gICAgICAgICAgaWYgKGxhenlTdGVwU3RhcnQgJiYgIXZhbGlkYXRlZFN0ZXApIHtcbiAgICAgICAgICAgIGNvbnN0IGxhenlEYXRhID0gZGF0YS5ldmVudERhdGE7XG4gICAgICAgICAgICBjb25zdCBbaW5zZXJ0ZWRdID0gYXdhaXQgdHhcbiAgICAgICAgICAgICAgLmluc2VydChTY2hlbWEuc3RlcHMpXG4gICAgICAgICAgICAgIC52YWx1ZXMoe1xuICAgICAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgICAgICBzdGVwSWQ6IGRhdGEuY29ycmVsYXRpb25JZCxcbiAgICAgICAgICAgICAgICBzdGVwTmFtZTogbGF6eURhdGEuc3RlcE5hbWUsXG4gICAgICAgICAgICAgICAgaW5wdXQ6IGxhenlEYXRhLmlucHV0IGFzIFNlcmlhbGl6ZWRDb250ZW50LFxuICAgICAgICAgICAgICAgIHN0YXR1czogJ3BlbmRpbmcnLFxuICAgICAgICAgICAgICAgIGF0dGVtcHQ6IDAsXG4gICAgICAgICAgICAgICAgc3BlY1ZlcnNpb246IGVmZmVjdGl2ZVNwZWNWZXJzaW9uLFxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAub25Db25mbGljdERvTm90aGluZygpXG4gICAgICAgICAgICAgIC5yZXR1cm5pbmcoeyBzdGVwSWQ6IFNjaGVtYS5zdGVwcy5zdGVwSWQgfSk7XG5cbiAgICAgICAgICAgIGlmICghaW5zZXJ0ZWQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVudGl0eUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICAgICAgYFN0ZXAgXCIke2RhdGEuY29ycmVsYXRpb25JZH1cIiBhbHJlYWR5IGNyZWF0ZWRgXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIFJlcGxheSBzdGlsbCBuZWVkcyB0byBvYnNlcnZlIHN0ZXBfY3JlYXRlZCBiZWZvcmVcbiAgICAgICAgICAgIC8vIHN0ZXBfc3RhcnRlZC4gQmVjYXVzZSB0aGlzIHN5bnRoZXRpYyBldmVudCBpcyBpbiB0aGUgc2FtZVxuICAgICAgICAgICAgLy8gdHJhbnNhY3Rpb24gYXMgdGhlIGxhenkgc3RlcCByb3cgYW5kIHN0ZXBfc3RhcnRlZCBldmVudCwgd2VcbiAgICAgICAgICAgIC8vIGNhbm5vdCBsZWF2ZSBiZWhpbmQgb25seSBvbmUgc2lkZSBvZiB0aGF0IG1hdGVyaWFsaXphdGlvbi5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGF3YWl0IGluc2VydEV2ZW50Um93KHR4LCB7XG4gICAgICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgICAgICAgIGV2ZW50SWQ6IGF3YWl0IGFsbG9jYXRlRXZlbnRJZCh0eCwgZWZmZWN0aXZlUnVuSWQpLFxuICAgICAgICAgICAgICAgIGNvcnJlbGF0aW9uSWQ6IGRhdGEuY29ycmVsYXRpb25JZCxcbiAgICAgICAgICAgICAgICBldmVudFR5cGU6ICdzdGVwX2NyZWF0ZWQnLFxuICAgICAgICAgICAgICAgIGV2ZW50RGF0YToge1xuICAgICAgICAgICAgICAgICAgc3RlcE5hbWU6IGxhenlEYXRhLnN0ZXBOYW1lLFxuICAgICAgICAgICAgICAgICAgaW5wdXQ6IGxhenlEYXRhLmlucHV0LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgc3BlY1ZlcnNpb246IGVmZmVjdGl2ZVNwZWNWZXJzaW9uLFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAvLyBBIGNvbmN1cnJlbnQgd3JpdGVyIGFscmVhZHkgcHVibGlzaGVkIHRoaXMgcnVuJ3NcbiAgICAgICAgICAgICAgLy8gc3RlcF9jcmVhdGVkIGZvciB0aGUgc2FtZSBzdGVwLiBUaGUgZXZlbnQgZXhpc3RzIGVpdGhlciB3YXksXG4gICAgICAgICAgICAgIC8vIHdoaWNoIGlzIGFsbCB0aGlzIHN5bnRoZXRpYyB3cml0ZSB3YXMgZm9yLlxuICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgcGdFcnJvck9mKGVycikuY29uc3RyYWludCAhPT1cbiAgICAgICAgICAgICAgICAnd29ya2Zsb3dfZXZlbnRzX2VudGl0eV9jcmVhdGlvbl91bmlxdWUnXG4gICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3RlcENyZWF0ZWRMYXppbHkgPSB0cnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFJldHJpZWQgc3RlcHMgbWF5IGJlIHNjaGVkdWxlZCBmb3IgbGF0ZXIuIEtlZXAgdGhpcyBjaGVjayBpbnNpZGVcbiAgICAgICAgICAvLyB0aGUgdHJhbnNhY3Rpb24gc28gdGhlIHN0ZXBfc3RhcnRlZCB3cml0ZSBjYW5ub3Qgc2xpcCBwYXN0IGl0LlxuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHZhbGlkYXRlZFN0ZXA/LnJldHJ5QWZ0ZXIgJiZcbiAgICAgICAgICAgIHZhbGlkYXRlZFN0ZXAucmV0cnlBZnRlci5nZXRUaW1lKCkgPiBEYXRlLm5vdygpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVG9vRWFybHlFcnJvcihcbiAgICAgICAgICAgICAgYENhbm5vdCBzdGFydCBzdGVwIFwiJHtkYXRhLmNvcnJlbGF0aW9uSWR9XCI6IHJldHJ5QWZ0ZXIgdGltZXN0YW1wIGhhcyBub3QgYmVlbiByZWFjaGVkIHlldGAsXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICByZXRyeUFmdGVyOiBNYXRoLmNlaWwoXG4gICAgICAgICAgICAgICAgICAodmFsaWRhdGVkU3RlcC5yZXRyeUFmdGVyLmdldFRpbWUoKSAtIERhdGUubm93KCkpIC8gMTAwMFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gVGhlIHRlcm1pbmFsLXN0YXRlIGd1YXJkIGlzIHBhcnQgb2YgdGhlIFVQREFURSwgbm90IGp1c3QgdGhlXG4gICAgICAgICAgLy8gZWFybGllciB2YWxpZGF0aW9uIHJlYWQuIFRoYXQgY2xvc2VzIHRoZSByYWNlIHdoZXJlIGFub3RoZXJcbiAgICAgICAgICAvLyB3cml0ZXIgY29tcGxldGVzL2ZhaWxzIHRoZSBzdGVwIGJldHdlZW4gdmFsaWRhdGlvbiBhbmQgc3RhcnQuXG4gICAgICAgICAgY29uc3QgW3N0ZXBWYWx1ZV0gPSBhd2FpdCB0eFxuICAgICAgICAgICAgLnVwZGF0ZShTY2hlbWEuc3RlcHMpXG4gICAgICAgICAgICAuc2V0KHtcbiAgICAgICAgICAgICAgc3RhdHVzOiAncnVubmluZycsXG4gICAgICAgICAgICAgIGF0dGVtcHQ6IHNxbGAke1NjaGVtYS5zdGVwcy5hdHRlbXB0fSArIDFgLFxuICAgICAgICAgICAgICAvLyBQcmVzZXJ2ZSB0aGUgb3JpZ2luYWwgZmlyc3Qtc3RhcnQgdGltZXN0YW1wIGFjcm9zcyByZXRyaWVzIG9yXG4gICAgICAgICAgICAgIC8vIG92ZXJsYXBwaW5nIHN0YXJ0cy5cbiAgICAgICAgICAgICAgc3RhcnRlZEF0OiBzcWxgQ09BTEVTQ0UoJHtTY2hlbWEuc3RlcHMuc3RhcnRlZEF0fSwgJHtub3cudG9JU09TdHJpbmcoKX0pYCxcbiAgICAgICAgICAgICAgcmV0cnlBZnRlcjogbnVsbCxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAud2hlcmUoXG4gICAgICAgICAgICAgIGFuZChcbiAgICAgICAgICAgICAgICBlcShTY2hlbWEuc3RlcHMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSxcbiAgICAgICAgICAgICAgICBlcShTY2hlbWEuc3RlcHMuc3RlcElkLCBkYXRhLmNvcnJlbGF0aW9uSWQhKSxcbiAgICAgICAgICAgICAgICBub3RJbkFycmF5KFNjaGVtYS5zdGVwcy5zdGF0dXMsIHRlcm1pbmFsU3RlcFN0YXR1c2VzKVxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAucmV0dXJuaW5nKCk7XG5cbiAgICAgICAgICBpZiAoc3RlcFZhbHVlKSB7XG4gICAgICAgICAgICBzdGVwID0gZGVzZXJpYWxpemVTdGVwRXJyb3IoY29tcGFjdChzdGVwVmFsdWUpKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgW2V4aXN0aW5nXSA9IGF3YWl0IHR4XG4gICAgICAgICAgICAgIC5zZWxlY3QoeyBzdGF0dXM6IFNjaGVtYS5zdGVwcy5zdGF0dXMgfSlcbiAgICAgICAgICAgICAgLmZyb20oU2NoZW1hLnN0ZXBzKVxuICAgICAgICAgICAgICAud2hlcmUoXG4gICAgICAgICAgICAgICAgYW5kKFxuICAgICAgICAgICAgICAgICAgZXEoU2NoZW1hLnN0ZXBzLnJ1bklkLCBlZmZlY3RpdmVSdW5JZCksXG4gICAgICAgICAgICAgICAgICBlcShTY2hlbWEuc3RlcHMuc3RlcElkLCBkYXRhLmNvcnJlbGF0aW9uSWQhKVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAubGltaXQoMSk7XG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBXb3JrZmxvd1dvcmxkRXJyb3IoXG4gICAgICAgICAgICAgICAgYFN0ZXAgXCIke2RhdGEuY29ycmVsYXRpb25JZH1cIiBub3QgZm91bmRgXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbFN0ZXBTdGF0dXMoZXhpc3Rpbmcuc3RhdHVzKSkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgICAgICBgQ2Fubm90IG1vZGlmeSBzdGVwIGluIHRlcm1pbmFsIHN0YXRlIFwiJHtleGlzdGluZy5zdGF0dXN9XCJgXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQWxsb2NhdGUgdGhlIHN0ZXBfc3RhcnRlZCBwb3NpdGlvbiBvbmx5IGFmdGVyIHRoZSBndWFyZGVkIHN0ZXBcbiAgICAgICAgICAvLyBVUERBVEUgaGFzIGFjcXVpcmVkIGFuZCBwYXNzZWQgdGhlIHJvdyBsb2NrLCBzbyBhIHdyaXRlciBibG9ja2VkXG4gICAgICAgICAgLy8gb24gdGhlIHN0ZXAgcm93IGNhbm5vdCBjYXJyeSBhbiBlYXJsaWVyIHBvc2l0aW9uIGludG8gYSBsYXRlclxuICAgICAgICAgIC8vIGluc2VydC5cbiAgICAgICAgICBjb25zdCBldmVudFZhbHVlID0gYXdhaXQgaW5zZXJ0RXZlbnRSb3codHgsIHtcbiAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgIGV2ZW50SWQ6IGF3YWl0IGFsbG9jYXRlRXZlbnRJZCh0eCwgZWZmZWN0aXZlUnVuSWQpLFxuICAgICAgICAgICAgY29ycmVsYXRpb25JZDogZGF0YS5jb3JyZWxhdGlvbklkLFxuICAgICAgICAgICAgZXZlbnRUeXBlOiBkYXRhLmV2ZW50VHlwZSxcbiAgICAgICAgICAgIGV2ZW50RGF0YTogc3RvcmVkRXZlbnREYXRhLFxuICAgICAgICAgICAgc3BlY1ZlcnNpb246IGVmZmVjdGl2ZVNwZWNWZXJzaW9uLFxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgaWYgKCFldmVudFZhbHVlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgICAgYEV2ZW50IGZvciBzdGVwIFwiJHtkYXRhLmNvcnJlbGF0aW9uSWR9XCIgY291bGQgbm90IGJlIGNyZWF0ZWRgXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBldmVudElkID0gZXZlbnRWYWx1ZS5ldmVudElkO1xuICAgICAgICAgIHJldHVybiB7IGNyZWF0ZWRBdDogZXZlbnRWYWx1ZS5jcmVhdGVkQXQgfTtcbiAgICAgICAgfSwgU0xPVF9JTlNFUlRfVFJBTlNBQ1RJT04pO1xuICAgICAgfVxuXG4gICAgICAvLyBIYW5kbGUgc3RlcF9jb21wbGV0ZWQgZXZlbnQ6IHVwZGF0ZSBzdGVwIHN0YXR1c1xuICAgICAgLy8gVXNlcyBjb25kaXRpb25hbCBVUERBVEUgdG8gcHJldmVudCBjb21wbGV0aW5nIGFuIGFscmVhZHktdGVybWluYWwgc3RlcC5cbiAgICAgIGlmIChkYXRhLmV2ZW50VHlwZSA9PT0gJ3N0ZXBfY29tcGxldGVkJykge1xuICAgICAgICBjb25zdCBldmVudERhdGEgPSAoZGF0YSBhcyBhbnkpLmV2ZW50RGF0YSBhcyB7IHJlc3VsdD86IGFueSB9O1xuICAgICAgICBjb25zdCBbc3RlcFZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAudXBkYXRlKFNjaGVtYS5zdGVwcylcbiAgICAgICAgICAuc2V0KHtcbiAgICAgICAgICAgIHN0YXR1czogJ2NvbXBsZXRlZCcsXG4gICAgICAgICAgICBvdXRwdXQ6IGV2ZW50RGF0YS5yZXN1bHQgYXMgU2VyaWFsaXplZENvbnRlbnQgfCB1bmRlZmluZWQsXG4gICAgICAgICAgICBjb21wbGV0ZWRBdDogbm93LFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLndoZXJlKFxuICAgICAgICAgICAgYW5kKFxuICAgICAgICAgICAgICBlcShTY2hlbWEuc3RlcHMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSxcbiAgICAgICAgICAgICAgZXEoU2NoZW1hLnN0ZXBzLnN0ZXBJZCwgZGF0YS5jb3JyZWxhdGlvbklkISksXG4gICAgICAgICAgICAgIG5vdEluQXJyYXkoU2NoZW1hLnN0ZXBzLnN0YXR1cywgdGVybWluYWxTdGVwU3RhdHVzZXMpXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICAgIC5yZXR1cm5pbmcoKTtcbiAgICAgICAgaWYgKHN0ZXBWYWx1ZSkge1xuICAgICAgICAgIHN0ZXAgPSBkZXNlcmlhbGl6ZVN0ZXBFcnJvcihjb21wYWN0KHN0ZXBWYWx1ZSkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFN0ZXAgbm90IHVwZGF0ZWQgLSBjaGVjayBpZiBpdCBleGlzdHMgYW5kIHdoeVxuICAgICAgICAgIGNvbnN0IFtleGlzdGluZ10gPSBhd2FpdCBnZXRTdGVwRm9yVmFsaWRhdGlvbi5leGVjdXRlKHtcbiAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgIHN0ZXBJZDogZGF0YS5jb3JyZWxhdGlvbklkISxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dXb3JsZEVycm9yKFxuICAgICAgICAgICAgICBgU3RlcCBcIiR7ZGF0YS5jb3JyZWxhdGlvbklkfVwiIG5vdCBmb3VuZGBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChpc1Rlcm1pbmFsU3RlcFN0YXR1cyhleGlzdGluZy5zdGF0dXMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgICAgYENhbm5vdCBtb2RpZnkgc3RlcCBpbiB0ZXJtaW5hbCBzdGF0ZSBcIiR7ZXhpc3Rpbmcuc3RhdHVzfVwiYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSGFuZGxlIHN0ZXBfZmFpbGVkIGV2ZW50OiB0ZXJtaW5hbCBzdGF0ZSB3aXRoIGVycm9yXG4gICAgICAvLyBVc2VzIGNvbmRpdGlvbmFsIFVQREFURSB0byBwcmV2ZW50IGZhaWxpbmcgYW4gYWxyZWFkeS10ZXJtaW5hbCBzdGVwLlxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAnc3RlcF9mYWlsZWQnKSB7XG4gICAgICAgIGNvbnN0IGV2ZW50RGF0YSA9IChkYXRhIGFzIGFueSkuZXZlbnREYXRhIGFzIHtcbiAgICAgICAgICBlcnJvcj86IHVua25vd247XG4gICAgICAgIH07XG4gICAgICAgIC8vIFRoZSBlcnJvciBmaWVsZCBpcyBTZXJpYWxpemVkRGF0YSAoVWludDhBcnJheSkgcHJvZHVjZWQgYnlcbiAgICAgICAgLy8gZGVoeWRyYXRlU3RlcEVycm9yLiBXZSBzdG9yZSBpdCB2ZXJiYXRpbSBpbiB0aGUgZXJyb3JfY2JvciBjb2x1bW47XG4gICAgICAgIC8vIGNvbnN1bWVycyBoeWRyYXRlIHZpYSBoeWRyYXRlU3RlcEVycm9yLlxuICAgICAgICBjb25zdCBbc3RlcFZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAudXBkYXRlKFNjaGVtYS5zdGVwcylcbiAgICAgICAgICAuc2V0KHtcbiAgICAgICAgICAgIHN0YXR1czogJ2ZhaWxlZCcsXG4gICAgICAgICAgICBlcnJvcjogZXZlbnREYXRhLmVycm9yIGFzIFNlcmlhbGl6ZWREYXRhLFxuICAgICAgICAgICAgY29tcGxldGVkQXQ6IG5vdyxcbiAgICAgICAgICB9KVxuICAgICAgICAgIC53aGVyZShcbiAgICAgICAgICAgIGFuZChcbiAgICAgICAgICAgICAgZXEoU2NoZW1hLnN0ZXBzLnJ1bklkLCBlZmZlY3RpdmVSdW5JZCksXG4gICAgICAgICAgICAgIGVxKFNjaGVtYS5zdGVwcy5zdGVwSWQsIGRhdGEuY29ycmVsYXRpb25JZCEpLFxuICAgICAgICAgICAgICBub3RJbkFycmF5KFNjaGVtYS5zdGVwcy5zdGF0dXMsIHRlcm1pbmFsU3RlcFN0YXR1c2VzKVxuICAgICAgICAgICAgKVxuICAgICAgICAgIClcbiAgICAgICAgICAucmV0dXJuaW5nKCk7XG4gICAgICAgIGlmIChzdGVwVmFsdWUpIHtcbiAgICAgICAgICBzdGVwID0gZGVzZXJpYWxpemVTdGVwRXJyb3IoY29tcGFjdChzdGVwVmFsdWUpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBTdGVwIG5vdCB1cGRhdGVkIC0gY2hlY2sgaWYgaXQgZXhpc3RzIGFuZCB3aHlcbiAgICAgICAgICBjb25zdCBbZXhpc3RpbmddID0gYXdhaXQgZ2V0U3RlcEZvclZhbGlkYXRpb24uZXhlY3V0ZSh7XG4gICAgICAgICAgICBydW5JZDogZWZmZWN0aXZlUnVuSWQsXG4gICAgICAgICAgICBzdGVwSWQ6IGRhdGEuY29ycmVsYXRpb25JZCEsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93V29ybGRFcnJvcihcbiAgICAgICAgICAgICAgYFN0ZXAgXCIke2RhdGEuY29ycmVsYXRpb25JZH1cIiBub3QgZm91bmRgXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoaXNUZXJtaW5hbFN0ZXBTdGF0dXMoZXhpc3Rpbmcuc3RhdHVzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVudGl0eUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICAgIGBDYW5ub3QgbW9kaWZ5IHN0ZXAgaW4gdGVybWluYWwgc3RhdGUgXCIke2V4aXN0aW5nLnN0YXR1c31cImBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEhhbmRsZSBzdGVwX3JldHJ5aW5nIGV2ZW50OiBzZXRzIHN0YXR1cyBiYWNrIHRvICdwZW5kaW5nJywgcmVjb3JkcyBlcnJvclxuICAgICAgLy8gVXNlcyBjb25kaXRpb25hbCBVUERBVEUgdG8gcHJldmVudCByZXRyeWluZyBhbiBhbHJlYWR5LXRlcm1pbmFsIHN0ZXAuXG4gICAgICBpZiAoZGF0YS5ldmVudFR5cGUgPT09ICdzdGVwX3JldHJ5aW5nJykge1xuICAgICAgICBjb25zdCBldmVudERhdGEgPSAoZGF0YSBhcyBhbnkpLmV2ZW50RGF0YSBhcyB7XG4gICAgICAgICAgZXJyb3I/OiB1bmtub3duO1xuICAgICAgICAgIHJldHJ5QWZ0ZXI/OiBEYXRlO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCBbc3RlcFZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAudXBkYXRlKFNjaGVtYS5zdGVwcylcbiAgICAgICAgICAuc2V0KHtcbiAgICAgICAgICAgIHN0YXR1czogJ3BlbmRpbmcnLFxuICAgICAgICAgICAgZXJyb3I6IGV2ZW50RGF0YS5lcnJvciBhcyBTZXJpYWxpemVkRGF0YSxcbiAgICAgICAgICAgIHJldHJ5QWZ0ZXI6IGV2ZW50RGF0YS5yZXRyeUFmdGVyLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLndoZXJlKFxuICAgICAgICAgICAgYW5kKFxuICAgICAgICAgICAgICBlcShTY2hlbWEuc3RlcHMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSxcbiAgICAgICAgICAgICAgZXEoU2NoZW1hLnN0ZXBzLnN0ZXBJZCwgZGF0YS5jb3JyZWxhdGlvbklkISksXG4gICAgICAgICAgICAgIG5vdEluQXJyYXkoU2NoZW1hLnN0ZXBzLnN0YXR1cywgdGVybWluYWxTdGVwU3RhdHVzZXMpXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICAgIC5yZXR1cm5pbmcoKTtcbiAgICAgICAgaWYgKHN0ZXBWYWx1ZSkge1xuICAgICAgICAgIHN0ZXAgPSBkZXNlcmlhbGl6ZVN0ZXBFcnJvcihjb21wYWN0KHN0ZXBWYWx1ZSkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFN0ZXAgbm90IHVwZGF0ZWQgLSBjaGVjayBpZiBpdCBleGlzdHMgYW5kIHdoeVxuICAgICAgICAgIGNvbnN0IFtleGlzdGluZ10gPSBhd2FpdCBnZXRTdGVwRm9yVmFsaWRhdGlvbi5leGVjdXRlKHtcbiAgICAgICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICAgIHN0ZXBJZDogZGF0YS5jb3JyZWxhdGlvbklkISxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dXb3JsZEVycm9yKFxuICAgICAgICAgICAgICBgU3RlcCBcIiR7ZGF0YS5jb3JyZWxhdGlvbklkfVwiIG5vdCBmb3VuZGBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChpc1Rlcm1pbmFsU3RlcFN0YXR1cyhleGlzdGluZy5zdGF0dXMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgICAgYENhbm5vdCBtb2RpZnkgc3RlcCBpbiB0ZXJtaW5hbCBzdGF0ZSBcIiR7ZXhpc3Rpbmcuc3RhdHVzfVwiYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSGFuZGxlIGhvb2tfY3JlYXRlZCBldmVudDogY3JlYXRlIGhvb2sgZW50aXR5XG4gICAgICAvLyBVc2VzIHByZXBhcmVkIHN0YXRlbWVudCBmb3IgdG9rZW4gdW5pcXVlbmVzcyBjaGVjayAocGVyZm9ybWFuY2Ugb3B0aW1pemF0aW9uKVxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAnaG9va19jcmVhdGVkJykge1xuICAgICAgICBjb25zdCB7IGV2ZW50RGF0YSB9ID0gZGF0YTtcblxuICAgICAgICAvLyBDaGVjayBmb3IgZHVwbGljYXRlIHRva2VuIHVzaW5nIHByZXBhcmVkIHN0YXRlbWVudFxuICAgICAgICBjb25zdCBbZXhpc3RpbmdIb29rXSA9IGF3YWl0IGdldEhvb2tCeVRva2VuLmV4ZWN1dGUoe1xuICAgICAgICAgIHRva2VuOiBldmVudERhdGEudG9rZW4sXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoZXhpc3RpbmdIb29rKSB7XG4gICAgICAgICAgLy8gSWRlbXBvdGVuY3k6IGlmIHRoZSBleGlzdGluZyBob29rIGlzIHRoZSAqc2FtZSogKHJ1bklkLCBob29rSWQpXG4gICAgICAgICAgLy8gd2UgYXJlIHRyeWluZyB0byBjcmVhdGUsIHRoaXMgaXMgZWl0aGVyIGEgZHVwbGljYXRlIC8gcmVwbGF5ZWRcbiAgICAgICAgICAvLyBwcm9jZXNzaW5nIG9mIHRoZSBzYW1lIGhvb2tfY3JlYXRlZCAobm90IGEgcmVhbCBjb25mbGljdCksIG9yXG4gICAgICAgICAgLy8gYW4gb3JwaGFuZWQgaG9vayByb3cgZnJvbSBhIHByaW9yIGNyYXNoZWQgYXR0ZW1wdCAodGhlIGhvb2tcbiAgICAgICAgICAvLyBJTlNFUlQgYmVsb3cgbGFuZGVkIGJ1dCB0aGUgZXZlbnRzIElOU0VSVCBiZWxvdyBkaWRuJ3Qg4oCUXG4gICAgICAgICAgLy8gdGhlc2Ugd3JpdGVzIGFyZSBub3QgaW4gb25lIHRyYW5zYWN0aW9uKS4gRGlzdGluZ3Vpc2ggYnlcbiAgICAgICAgICAvLyBjaGVja2luZyB3aGV0aGVyIHRoZSBgaG9va19jcmVhdGVkYCBldmVudCBhY3R1YWxseSBleGlzdHMgaW5cbiAgICAgICAgICAvLyB0aGUgZXZlbnQgbG9nOlxuICAgICAgICAgIC8vICAgLSBleGlzdHMg4oaSIHJlYWwgZHVwbGljYXRlOiB0aHJvdyBFbnRpdHlDb25mbGljdEVycm9yIHNvIHRoZVxuICAgICAgICAgIC8vICAgICBydW50aW1lJ3MgY29uY3VycmVudC1yZXBsYXkgY2F0Y2ggcGF0aCAobWF0Y2hpbmcgdGhlXG4gICAgICAgICAgLy8gICAgIHN0ZXBfY3JlYXRlZCBwYXRoKSBzd2FsbG93cyBpdCwgaW5zdGVhZCBvZiBwcm9kdWNpbmcgYVxuICAgICAgICAgIC8vICAgICBzZWxmLWNvbmZsaWN0IGluIHRoZSBldmVudCBsb2cgdGhhdCB3b3VsZCBsYXRlciByZXBsYXlcbiAgICAgICAgICAvLyAgICAgYXMgSG9va0NvbmZsaWN0RXJyb3IuXG4gICAgICAgICAgLy8gICAgIFNlZSBodHRwczovL2dpdGh1Yi5jb20vdmVyY2VsL3dvcmtmbG93L2lzc3Vlcy8yMjgzLlxuICAgICAgICAgIC8vICAgLSBtaXNzaW5nIOKGkiBvcnBoYW5lZCBob29rIHJvdyAoY3Jhc2ggYmV0d2VlbiBob29rIElOU0VSVFxuICAgICAgICAgIC8vICAgICBhbmQgZXZlbnRzIElOU0VSVCk6IHNraXAgdGhlIGhvb2sgaW5zZXJ0ICh0aGUgZXhpc3RpbmdcbiAgICAgICAgICAvLyAgICAgcm93IGFscmVhZHkgaGFzIHRoZSBkZXNpcmVkIHN0YXRlKSBhbmQgZmFsbCB0aHJvdWdoIHRvXG4gICAgICAgICAgLy8gICAgIHRoZSBldmVudHMgSU5TRVJUIGJlbG93LCBjb21wbGV0aW5nIHRoZSBwYXJ0aWFsIHdyaXRlLlxuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIGV4aXN0aW5nSG9vay5ydW5JZCA9PT0gZWZmZWN0aXZlUnVuSWQgJiZcbiAgICAgICAgICAgIGV4aXN0aW5nSG9vay5ob29rSWQgPT09IGRhdGEuY29ycmVsYXRpb25JZFxuICAgICAgICAgICkge1xuICAgICAgICAgICAgY29uc3QgW2V4aXN0aW5nRXZlbnRdID0gYXdhaXQgZ2V0SG9va0NyZWF0ZWRFdmVudC5leGVjdXRlKHtcbiAgICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgICAgICBjb3JyZWxhdGlvbklkOiBkYXRhLmNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgICAgIGV2ZW50VHlwZTogJ2hvb2tfY3JlYXRlZCcsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmIChleGlzdGluZ0V2ZW50KSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgICAgICAgIGBIb29rIFwiJHtkYXRhLmNvcnJlbGF0aW9uSWR9XCIgYWxyZWFkeSBjcmVhdGVkYFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gT3JwaGFuZWQgaG9vayByb3c6IGhvb2sgcm93IGV4aXN0cyBidXQgbm8gaG9va19jcmVhdGVkXG4gICAgICAgICAgICAvLyBldmVudCBpbiB0aGUgbG9nLiBTa2lwIHRoZSBob29rIGluc2VydCBiZWxvdyAodGhlIHJvd1xuICAgICAgICAgICAgLy8gYWxyZWFkeSBleGlzdHMgd2l0aCBvdXIgKHJ1bklkLCBob29rSWQpKSBhbmQgbGV0IHRoZVxuICAgICAgICAgICAgLy8gb3V0ZXIgY29kZSBwYXRoIGVtaXQgdGhlIGhvb2tfY3JlYXRlZCBldmVudCwgY29tcGxldGluZ1xuICAgICAgICAgICAgLy8gdGhlIHBhcnRpYWwgd3JpdGUuIFdlIGFsc28gcmUtZmV0Y2ggdGhlIGV4aXN0aW5nIGhvb2tcbiAgICAgICAgICAgIC8vIHJvdyBzbyB0aGUgRXZlbnRSZXN1bHQgY2FycmllcyB0aGUgYWN0dWFsIHBlcnNpc3RlZFxuICAgICAgICAgICAgLy8gZW50aXR5IHJhdGhlciB0aGFuIGB1bmRlZmluZWRgLlxuICAgICAgICAgICAgY29uc3QgW3JlY292ZXJlZEhvb2tWYWx1ZV0gPSBhd2FpdCBkcml6emxlXG4gICAgICAgICAgICAgIC5zZWxlY3QoKVxuICAgICAgICAgICAgICAuZnJvbShTY2hlbWEuaG9va3MpXG4gICAgICAgICAgICAgIC53aGVyZShlcShTY2hlbWEuaG9va3MuaG9va0lkLCBkYXRhLmNvcnJlbGF0aW9uSWQhKSlcbiAgICAgICAgICAgICAgLmxpbWl0KDEpO1xuICAgICAgICAgICAgaWYgKHJlY292ZXJlZEhvb2tWYWx1ZSkge1xuICAgICAgICAgICAgICByZWNvdmVyZWRIb29rVmFsdWUubWV0YWRhdGEgfHw9IHJlY292ZXJlZEhvb2tWYWx1ZS5tZXRhZGF0YUpzb247XG4gICAgICAgICAgICAgIGhvb2sgPSBIb29rU2NoZW1hLnBhcnNlKGNvbXBhY3QocmVjb3ZlcmVkSG9va1ZhbHVlKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIENyb3NzLWhvb2sgLyBjcm9zcy1ydW4gY29uZmxpY3Q6IGEgZGlmZmVyZW50XG4gICAgICAgICAgICAvLyAocnVuSWQsIGhvb2tJZCkgaG9sZHMgdGhpcyB0b2tlbi4gQ3JlYXRlIGEgaG9va19jb25mbGljdFxuICAgICAgICAgICAgLy8gZXZlbnQgaW5zdGVhZCBvZiB0aHJvd2luZyA0MDkg4oCUIHRoaXMgbGV0cyB0aGUgd29ya2Zsb3dcbiAgICAgICAgICAgIC8vIGNvbnRpbnVlIGFuZCBmYWlsIGdyYWNlZnVsbHkgd2hlbiB0aGUgaG9vayBpcyBhd2FpdGVkLlxuICAgICAgICAgICAgY29uc3QgY29uZmxpY3RFdmVudERhdGEgPSB7XG4gICAgICAgICAgICAgIHRva2VuOiBldmVudERhdGEudG9rZW4sXG4gICAgICAgICAgICAgIGNvbmZsaWN0aW5nUnVuSWQ6IGV4aXN0aW5nSG9vay5ydW5JZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBjb25mbGljdFZhbHVlID0gYXdhaXQgaW5zZXJ0RXZlbnRSb3coZHJpenpsZSwge1xuICAgICAgICAgICAgICBydW5JZDogZWZmZWN0aXZlUnVuSWQsXG4gICAgICAgICAgICAgIGV2ZW50SWQ6IGF3YWl0IGdldEV2ZW50SWQoKSxcbiAgICAgICAgICAgICAgY29ycmVsYXRpb25JZDogZGF0YS5jb3JyZWxhdGlvbklkLFxuICAgICAgICAgICAgICBldmVudFR5cGU6ICdob29rX2NvbmZsaWN0JyxcbiAgICAgICAgICAgICAgZXZlbnREYXRhOiBjb25mbGljdEV2ZW50RGF0YSxcbiAgICAgICAgICAgICAgc3BlY1ZlcnNpb246IGVmZmVjdGl2ZVNwZWNWZXJzaW9uLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmICghY29uZmxpY3RWYWx1ZSkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgICAgICBgaG9va19jb25mbGljdCBmb3IgcnVuIFwiJHtlZmZlY3RpdmVSdW5JZH1cIiBjb3VsZCBub3QgYmUgY3JlYXRlZGBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGNvbmZsaWN0RXZlbnRJZCA9IGNvbmZsaWN0VmFsdWUuZXZlbnRJZDtcbiAgICAgICAgICAgIGV2ZW50SWQgPSBjb25mbGljdEV2ZW50SWQ7XG5cbiAgICAgICAgICAgIGNvbnN0IGNvbmZsaWN0UmVzdWx0ID0ge1xuICAgICAgICAgICAgICBldmVudFR5cGU6ICdob29rX2NvbmZsaWN0JyBhcyBjb25zdCxcbiAgICAgICAgICAgICAgY29ycmVsYXRpb25JZDogZGF0YS5jb3JyZWxhdGlvbklkLFxuICAgICAgICAgICAgICBldmVudERhdGE6IGNvbmZsaWN0RXZlbnREYXRhLFxuICAgICAgICAgICAgICAuLi5jb25mbGljdFZhbHVlLFxuICAgICAgICAgICAgICBydW5JZDogZWZmZWN0aXZlUnVuSWQsXG4gICAgICAgICAgICAgIGV2ZW50SWQ6IGNvbmZsaWN0RXZlbnRJZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBwYXJzZWRDb25mbGljdCA9IEV2ZW50U2NoZW1hLnBhcnNlKGNvbmZsaWN0UmVzdWx0KTtcbiAgICAgICAgICAgIGNvbnN0IHJlc29sdmVEYXRhID0gcGFyYW1zPy5yZXNvbHZlRGF0YSA/PyAnYWxsJztcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIGV2ZW50OiBzdHJpcEV2ZW50RGF0YVJlZnMocGFyc2VkQ29uZmxpY3QsIHJlc29sdmVEYXRhKSxcbiAgICAgICAgICAgICAgcnVuLFxuICAgICAgICAgICAgICBzdGVwLFxuICAgICAgICAgICAgICBob29rOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhd2FpdCBkcml6emxlXG4gICAgICAgICAgICAuZGVsZXRlKFNjaGVtYS5ob29rcylcbiAgICAgICAgICAgIC53aGVyZShcbiAgICAgICAgICAgICAgYW5kKFxuICAgICAgICAgICAgICAgIGVxKFNjaGVtYS5ob29rcy50b2tlbiwgZXZlbnREYXRhLnRva2VuKSxcbiAgICAgICAgICAgICAgICBleGlzdHMob3duZXJSdW5Jc1Rlcm1pbmFsKSxcbiAgICAgICAgICAgICAgICBob29rUmV0ZW50aW9uRW5kZWRcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgIGNvbnN0IFtob29rVmFsdWVdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgICAgLmluc2VydChTY2hlbWEuaG9va3MpXG4gICAgICAgICAgICAudmFsdWVzKHtcbiAgICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgICAgICBob29rSWQ6IGRhdGEuY29ycmVsYXRpb25JZCEsXG4gICAgICAgICAgICAgIHRva2VuOiBldmVudERhdGEudG9rZW4sXG4gICAgICAgICAgICAgIG1ldGFkYXRhOiBldmVudERhdGEubWV0YWRhdGEgYXMgU2VyaWFsaXplZENvbnRlbnQsXG4gICAgICAgICAgICAgIG93bmVySWQ6ICcnLCAvLyBUT0RPOiBnZXQgZnJvbSBjb250ZXh0XG4gICAgICAgICAgICAgIHByb2plY3RJZDogJycsIC8vIFRPRE86IGdldCBmcm9tIGNvbnRleHRcbiAgICAgICAgICAgICAgZW52aXJvbm1lbnQ6ICcnLCAvLyBUT0RPOiBnZXQgZnJvbSBjb250ZXh0XG4gICAgICAgICAgICAgIHRva2VuUmV0ZW50aW9uVW50aWw6IGV2ZW50RGF0YS50b2tlblJldGVudGlvblVudGlsLFxuICAgICAgICAgICAgICAvLyBQcm9wYWdhdGUgc3BlY1ZlcnNpb24gZnJvbSB0aGUgZXZlbnQgdG8gdGhlIGhvb2sgZW50aXR5XG4gICAgICAgICAgICAgIHNwZWNWZXJzaW9uOiBlZmZlY3RpdmVTcGVjVmVyc2lvbixcbiAgICAgICAgICAgICAgaXNXZWJob29rOiBldmVudERhdGEuaXNXZWJob29rLFxuICAgICAgICAgICAgICBpc1N5c3RlbTogZXZlbnREYXRhLmlzU3lzdGVtID8/IGZhbHNlLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5vbkNvbmZsaWN0RG9Ob3RoaW5nKClcbiAgICAgICAgICAgIC5yZXR1cm5pbmcoKTtcbiAgICAgICAgICBpZiAoaG9va1ZhbHVlKSB7XG4gICAgICAgICAgICBob29rVmFsdWUubWV0YWRhdGEgfHw9IGhvb2tWYWx1ZS5tZXRhZGF0YUpzb247XG4gICAgICAgICAgICBob29rID0gSG9va1NjaGVtYS5wYXJzZShjb21wYWN0KGhvb2tWYWx1ZSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBIYW5kbGUgaG9va19kaXNwb3NlZCBldmVudDogZGVsZXRlIHRoZSBob29rIGVudGl0eSBhbmQgYXBwZW5kIHRoZVxuICAgICAgLy8gZGlzcG9zYWwgaW4gT05FIHRyYW5zYWN0aW9uLlxuICAgICAgLy9cbiAgICAgIC8vIGBERUxFVEUgLi4uIFJFVFVSTklOR2AgZW5zdXJlcyBvbmx5IG9uZSBjb25jdXJyZW50IGNhbGxlciBzdWNjZWVkcyDigJQgaWZcbiAgICAgIC8vIG5vIHJvd3MgYXJlIHJldHVybmVkLCB0aGUgaG9vayB3YXMgYWxyZWFkeSBkaXNwb3NlZC4gVGhlIGRlbGV0ZSBhbHNvXG4gICAgICAvLyB0YWtlcyB0aGUgaG9vayByb3cncyBsb2NrLCBhbmQgdGhlIHRyYW5zYWN0aW9uIGlzIHdoYXQgaG9sZHMgaXQgdW50aWxcbiAgICAgIC8vIHRoZSBgaG9va19kaXNwb3NlZGAgcm93IGV4aXN0cy4gQ29tbWl0dGVkIHNlcGFyYXRlbHkgKGFzIHRoaXMgdXNlZCB0b1xuICAgICAgLy8gYmUpLCB0aGUgbG9jayBpcyByZWxlYXNlZCBhdCB0aGUgZGVsZXRlJ3Mgb3duIGF1dG9jb21taXQsIHdoaWNoIGxlYXZlcyBhXG4gICAgICAvLyB3aW5kb3cgZm9yIGEgcmVzdW1lIHRvIHBhc3MgaXRzIGV4aXN0ZW5jZSBjaGVjayBhbmQgbGFuZCBpdHNcbiAgICAgIC8vIGBob29rX3JlY2VpdmVkYCBBRlRFUiB0aGlzIGRpc3Bvc2FsLiBUaGF0IG9yZGVyIGlzIGR1cmFibGUsIGFuZCBpdFxuICAgICAgLy8gY29ycnVwdHMgdGhlIG93bmluZyBydW4gZm9yIGdvb2Q6IG5vIHJlcGxheSBjYW4gY29uc3VtZSBhIGRlbGl2ZXJ5XG4gICAgICAvLyBiZWhpbmQgdGhlIGRpc3Bvc2FsIHRoYXQgcmV0aXJlZCB0aGUgaG9vaydzIGNvbnN1bWVyLCBzbyBpdCBzdHJhbmRzLFxuICAgICAgLy8gZXZlcnkgcmVwbGF5IHJlcG9ydHMgZGl2ZXJnZW5jZSBhbmQgdGhlIHJ1biBlbmRzIGluXG4gICAgICAvLyBDb3JydXB0ZWRFdmVudExvZ0Vycm9yLiBTZWUgdmVyY2VsL3dvcmtmbG93IzI3ODEsIHdoaWNoIGZpeGVkIHRoZSBzYW1lXG4gICAgICAvLyBvcmRlcmluZyBmb3Igd29ybGQtbG9jYWwuXG4gICAgICBpZiAoZGF0YS5ldmVudFR5cGUgPT09ICdob29rX2Rpc3Bvc2VkJyAmJiBkYXRhLmNvcnJlbGF0aW9uSWQpIHtcbiAgICAgICAgY29uc3QgZGlzcG9zZWRIb29rSWQgPSBkYXRhLmNvcnJlbGF0aW9uSWQ7XG4gICAgICAgIHZhbHVlID0gYXdhaXQgZHJpenpsZS50cmFuc2FjdGlvbihhc3luYyAodHgpID0+IHtcbiAgICAgICAgICBjb25zdCBbZGVsZXRlZF0gPSBhd2FpdCB0eFxuICAgICAgICAgICAgLmRlbGV0ZShTY2hlbWEuaG9va3MpXG4gICAgICAgICAgICAud2hlcmUoZXEoU2NoZW1hLmhvb2tzLmhvb2tJZCwgZGlzcG9zZWRIb29rSWQpKVxuICAgICAgICAgICAgLnJldHVybmluZyh7IGhvb2tJZDogU2NoZW1hLmhvb2tzLmhvb2tJZCB9KTtcbiAgICAgICAgICBpZiAoIWRlbGV0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgICAgICBgSG9vayBcIiR7ZGlzcG9zZWRIb29rSWR9XCIgYWxyZWFkeSBkaXNwb3NlZGBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQWxsb2NhdGVkIG9ubHkgYWZ0ZXIgdGhlIGxvY2sgaXMgaGVsZCwgbWF0Y2hpbmcgaG9va19yZWNlaXZlZCdzXG4gICAgICAgICAgLy8gb3JkZXJpbmcgZ3VhcmFudGVlOiBhIHdyaXRlciB0aGF0IGhhZCB0byB3YWl0IG11c3Qgbm90IGNhcnJ5IGFuXG4gICAgICAgICAgLy8gZWFybGllciBwb3NpdGlvbiBpbnRvIGEgbGF0ZXIgaW5zZXJ0LlxuICAgICAgICAgIGNvbnN0IGV2ZW50VmFsdWUgPSBhd2FpdCBpbnNlcnRFdmVudFJvdyh0eCwge1xuICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgICAgZXZlbnRJZDogYXdhaXQgZ2V0RXZlbnRJZCh0eCksXG4gICAgICAgICAgICBjb3JyZWxhdGlvbklkOiBkaXNwb3NlZEhvb2tJZCxcbiAgICAgICAgICAgIGV2ZW50VHlwZTogZGF0YS5ldmVudFR5cGUsXG4gICAgICAgICAgICBldmVudERhdGE6IHN0b3JlZEV2ZW50RGF0YSxcbiAgICAgICAgICAgIHNwZWNWZXJzaW9uOiBlZmZlY3RpdmVTcGVjVmVyc2lvbixcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAoIWV2ZW50VmFsdWUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgICAgICBgRXZlbnQgZm9yIGhvb2sgXCIke2Rpc3Bvc2VkSG9va0lkfVwiIGNvdWxkIG5vdCBiZSBjcmVhdGVkYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZXZlbnRJZCA9IGV2ZW50VmFsdWUuZXZlbnRJZDtcbiAgICAgICAgICByZXR1cm4geyBjcmVhdGVkQXQ6IGV2ZW50VmFsdWUuY3JlYXRlZEF0IH07XG4gICAgICAgIH0sIFNMT1RfSU5TRVJUX1RSQU5TQUNUSU9OKTtcbiAgICAgIH1cblxuICAgICAgLy8gSGFuZGxlIGhvb2tfcmVjZWl2ZWQgZXZlbnQ6IGFwcGVuZCB0aGUgZXZlbnQgb25seSBpZiB0aGUgcnVuIGhhc1xuICAgICAgLy8gbm90IHJlYWNoZWQgYSB0ZXJtaW5hbCBzdGF0ZS4gaG9va19yZWNlaXZlZCBoYXMgbm8gYnJhbmNoIGluIHRoZVxuICAgICAgLy8gdGVybWluYWwtcnVuIGd1YXJkIGFib3ZlIChpdCBkb2Vzbid0IHRyYW5zaXRpb24gdGhlIHJ1biBvciBjcmVhdGVcbiAgICAgIC8vIGFuIGVudGl0eSksIHNvIHdpdGhvdXQgdGhpcywgdGhlIGdlbmVyaWMgSU5TRVJUIGZ1cnRoZXIgYmVsb3dcbiAgICAgIC8vIGNvdWxkIGFwcGVuZCBhIGhvb2tfcmVjZWl2ZWQgZXZlbnQgYWZ0ZXIgYSBjb25jdXJyZW50XG4gICAgICAvLyBydW5fY29tcGxldGVkIC8gcnVuX2ZhaWxlZCAvIHJ1bl9jYW5jZWxsZWQgaGFzIGFscmVhZHkgY29tbWl0dGVkLlxuICAgICAgLy8gYEZPUiBVUERBVEVgIHRha2VzIHRoZSBydW4gcm93IGxvY2sgaW5zaWRlIHRoaXMgdHJhbnNhY3Rpb246IGl0XG4gICAgICAvLyBibG9ja3MgdW50aWwgYW55IGluLWZsaWdodCB0ZXJtaW5hbCB0cmFuc2l0aW9uIOKAlCB3aG9zZSBvd25cbiAgICAgIC8vIGNvbmRpdGlvbmFsIFVQREFURSB0YWtlcyB0aGUgc2FtZSByb3cgbG9jayDigJQgY29tbWl0cywgdGhlblxuICAgICAgLy8gb2JzZXJ2ZXMgdGhlIHBvc3QtY29tbWl0IHN0YXR1cy4gVGhhdCBsaW5lYXJpemVzIHRoaXMgaW5zZXJ0XG4gICAgICAvLyBhZ2FpbnN0IHRoZSBydW4ncyB0ZXJtaW5hbCB0cmFuc2l0aW9uIHRoZSBzYW1lIHdheSBzdGVwX3N0YXJ0ZWQnc1xuICAgICAgLy8gZ3VhcmRlZCBVUERBVEUgbGluZWFyaXplcyBhZ2FpbnN0IGEgY29uY3VycmVudCB0ZXJtaW5hbCBzdGVwXG4gICAgICAvLyBldmVudC5cbiAgICAgIGlmIChkYXRhLmV2ZW50VHlwZSA9PT0gJ2hvb2tfcmVjZWl2ZWQnKSB7XG4gICAgICAgIHZhbHVlID0gYXdhaXQgZHJpenpsZS50cmFuc2FjdGlvbihhc3luYyAodHgpID0+IHtcbiAgICAgICAgICBjb25zdCBbcnVuUm93XSA9IGF3YWl0IHR4XG4gICAgICAgICAgICAuc2VsZWN0KHsgc3RhdHVzOiBTY2hlbWEucnVucy5zdGF0dXMgfSlcbiAgICAgICAgICAgIC5mcm9tKFNjaGVtYS5ydW5zKVxuICAgICAgICAgICAgLndoZXJlKGVxKFNjaGVtYS5ydW5zLnJ1bklkLCBlZmZlY3RpdmVSdW5JZCkpXG4gICAgICAgICAgICAuZm9yKCd1cGRhdGUnKVxuICAgICAgICAgICAgLmxpbWl0KDEpO1xuICAgICAgICAgIGlmICghcnVuUm93KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dSdW5Ob3RGb3VuZEVycm9yKGVmZmVjdGl2ZVJ1bklkKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGlzVGVybWluYWxXb3JrZmxvd1J1blN0YXR1cyhydW5Sb3cuc3RhdHVzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFJ1bkV4cGlyZWRFcnJvcihcbiAgICAgICAgICAgICAgYFdvcmtmbG93IHJ1biBcIiR7ZWZmZWN0aXZlUnVuSWR9XCIgaXMgYWxyZWFkeSBpbiB0ZXJtaW5hbCBzdGF0ZSBcIiR7cnVuUm93LnN0YXR1c31cImBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUmUtY2hlY2sgdGhlIGhvb2sgdW5kZXIgaXRzIG93biByb3cgbG9jaywgZm9yIHRoZSBvcmRlcmluZyB0aGVcbiAgICAgICAgICAvLyB1bmxvY2tlZCByZWFkIG5lYXIgdGhlIHRvcCBvZiBgY3JlYXRlYCBjYW5ub3Qgc2V0dGxlLiBgRk9SIFVQREFURWBcbiAgICAgICAgICAvLyBibG9ja3Mgb24gdGhlIGRpc3Bvc2VyJ3MgYERFTEVURWAsIHdoaWNoIGhvbGRzIHRoYXQgbG9jayB1bnRpbCBpdHNcbiAgICAgICAgICAvLyBgaG9va19kaXNwb3NlZGAgcm93IGlzIGNvbW1pdHRlZCwgdGhlbiByZS1ldmFsdWF0ZXM6IGVpdGhlciB0aGlzXG4gICAgICAgICAgLy8gZGVsaXZlcnkgZ290IHRoZSBsb2NrIGZpcnN0IGFuZCBpdHMgYGhvb2tfcmVjZWl2ZWRgIGlzIG9yZGVyZWRcbiAgICAgICAgICAvLyBCRUZPUkUgdGhlIGRpc3Bvc2FsLCBvciB0aGUgZGlzcG9zZXIgZ290IGl0IGFuZCB0aGUgcm93IGlzIGdvbmUgYW5kXG4gICAgICAgICAgLy8gdGhpcyBkZWxpdmVyeSBpcyByZWZ1c2VkLiBUaGUgb25lIG9yZGVyIHRoYXQgaXMgdW5yZWFjaGFibGUgaXMgdGhlXG4gICAgICAgICAgLy8gb25lIHRoYXQgY29ycnVwdHMgdGhlIHJ1biDigJQgYSBgaG9va19yZWNlaXZlZGAgam91cm5hbGVkIGJlaGluZCBpdHNcbiAgICAgICAgICAvLyBob29rJ3MgYGhvb2tfZGlzcG9zZWRgLCB3aGljaCBubyByZXBsYXkgY2FuIGNvbnN1bWUuXG4gICAgICAgICAgLy9cbiAgICAgICAgICAvLyBVbmRlciBSRUFEIENPTU1JVFRFRCAoc2VlIFNMT1RfSU5TRVJUX1RSQU5TQUNUSU9OKSBhIGxvY2tlZCByZWFkIG9mXG4gICAgICAgICAgLy8gYSByb3cgZGVsZXRlZCBieSB0aGUgdHJhbnNhY3Rpb24gaXQgd2FpdGVkIG9uIHJldHVybnMgbm8gcm93IHJhdGhlclxuICAgICAgICAgIC8vIHRoYW4gcmFpc2luZywgc28gdGhlIHJlZnVzYWwgbmVlZHMgbm8gc2VyaWFsaXphdGlvbi1mYWlsdXJlXG4gICAgICAgICAgLy8gaGFuZGxpbmcuIFJlcG9ydGVkIGFzIEhvb2tOb3RGb3VuZEVycm9yLCBtYXRjaGluZyB0aGUgdW5sb2NrZWRcbiAgICAgICAgICAvLyBjaGVjayBhbmQgdGhlIHB1YmxpYyByZXN1bWUgY29udHJhY3QgZm9yIGEgaG9vayB0aGF0IGNhbiBubyBsb25nZXJcbiAgICAgICAgICAvLyByZWNlaXZlLlxuICAgICAgICAgIGlmIChkYXRhLmNvcnJlbGF0aW9uSWQpIHtcbiAgICAgICAgICAgIGNvbnN0IFtsaXZlSG9va10gPSBhd2FpdCB0eFxuICAgICAgICAgICAgICAuc2VsZWN0KHsgaG9va0lkOiBTY2hlbWEuaG9va3MuaG9va0lkIH0pXG4gICAgICAgICAgICAgIC5mcm9tKFNjaGVtYS5ob29rcylcbiAgICAgICAgICAgICAgLndoZXJlKGVxKFNjaGVtYS5ob29rcy5ob29rSWQsIGRhdGEuY29ycmVsYXRpb25JZCkpXG4gICAgICAgICAgICAgIC5mb3IoJ3VwZGF0ZScpXG4gICAgICAgICAgICAgIC5saW1pdCgxKTtcbiAgICAgICAgICAgIGlmICghbGl2ZUhvb2spIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEhvb2tOb3RGb3VuZEVycm9yKGRhdGEuY29ycmVsYXRpb25JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQWxsb2NhdGUgdGhlIHBvc2l0aW9uIG9ubHkgYWZ0ZXIgdGhlIHJvdyBsb2NrcyBhcmUgYWNxdWlyZWQsXG4gICAgICAgICAgLy8gbWF0Y2hpbmcgc3RlcF9zdGFydGVkJ3Mgb3JkZXJpbmcgZ3VhcmFudGVlOiBhIHdyaXRlciBibG9ja2VkXG4gICAgICAgICAgLy8gb24gYSBsb2NrIG11c3Qgbm90IGNhcnJ5IGFuIGVhcmxpZXIgcG9zaXRpb24gaW50byBhIGxhdGVyXG4gICAgICAgICAgLy8gaW5zZXJ0LlxuICAgICAgICAgIGNvbnN0IGV2ZW50VmFsdWUgPSBhd2FpdCBpbnNlcnRFdmVudFJvdyh0eCwge1xuICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgICAgZXZlbnRJZDogYXdhaXQgYWxsb2NhdGVFdmVudElkKHR4LCBlZmZlY3RpdmVSdW5JZCksXG4gICAgICAgICAgICBjb3JyZWxhdGlvbklkOiBkYXRhLmNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgICBldmVudFR5cGU6IGRhdGEuZXZlbnRUeXBlLFxuICAgICAgICAgICAgZXZlbnREYXRhOiBzdG9yZWRFdmVudERhdGEsXG4gICAgICAgICAgICBzcGVjVmVyc2lvbjogZWZmZWN0aXZlU3BlY1ZlcnNpb24sXG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBpZiAoIWV2ZW50VmFsdWUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgICAgICBgRXZlbnQgZm9yIGhvb2sgXCIke2RhdGEuY29ycmVsYXRpb25JZH1cIiBjb3VsZCBub3QgYmUgY3JlYXRlZGBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGV2ZW50SWQgPSBldmVudFZhbHVlLmV2ZW50SWQ7XG4gICAgICAgICAgcmV0dXJuIHsgY3JlYXRlZEF0OiBldmVudFZhbHVlLmNyZWF0ZWRBdCB9O1xuICAgICAgICB9LCBTTE9UX0lOU0VSVF9UUkFOU0FDVElPTik7XG4gICAgICB9XG5cbiAgICAgIC8vIEhhbmRsZSB3YWl0X2NyZWF0ZWQgZXZlbnQ6IGNyZWF0ZSB3YWl0IGVudGl0eVxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAnd2FpdF9jcmVhdGVkJykge1xuICAgICAgICBjb25zdCBldmVudERhdGEgPSAoZGF0YSBhcyBhbnkpLmV2ZW50RGF0YSBhcyB7XG4gICAgICAgICAgcmVzdW1lQXQ/OiBEYXRlO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCB3YWl0SWQgPSBgJHtlZmZlY3RpdmVSdW5JZH0tJHtkYXRhLmNvcnJlbGF0aW9uSWR9YDtcbiAgICAgICAgY29uc3QgW3dhaXRWYWx1ZV0gPSBhd2FpdCBkcml6emxlXG4gICAgICAgICAgLmluc2VydChTY2hlbWEud2FpdHMpXG4gICAgICAgICAgLnZhbHVlcyh7XG4gICAgICAgICAgICB3YWl0SWQsXG4gICAgICAgICAgICBydW5JZDogZWZmZWN0aXZlUnVuSWQsXG4gICAgICAgICAgICBzdGF0dXM6ICd3YWl0aW5nJyxcbiAgICAgICAgICAgIHJlc3VtZUF0OiBldmVudERhdGEucmVzdW1lQXQsXG4gICAgICAgICAgICBzcGVjVmVyc2lvbjogZWZmZWN0aXZlU3BlY1ZlcnNpb24sXG4gICAgICAgICAgfSlcbiAgICAgICAgICAub25Db25mbGljdERvTm90aGluZygpXG4gICAgICAgICAgLnJldHVybmluZygpO1xuICAgICAgICBpZiAod2FpdFZhbHVlKSB7XG4gICAgICAgICAgd2FpdCA9IHtcbiAgICAgICAgICAgIHdhaXRJZDogd2FpdFZhbHVlLndhaXRJZCxcbiAgICAgICAgICAgIHJ1bklkOiB3YWl0VmFsdWUucnVuSWQsXG4gICAgICAgICAgICBzdGF0dXM6IHdhaXRWYWx1ZS5zdGF0dXMsXG4gICAgICAgICAgICByZXN1bWVBdDogd2FpdFZhbHVlLnJlc3VtZUF0ID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIGNvbXBsZXRlZEF0OiB3YWl0VmFsdWUuY29tcGxldGVkQXQgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgY3JlYXRlZEF0OiB3YWl0VmFsdWUuY3JlYXRlZEF0LFxuICAgICAgICAgICAgdXBkYXRlZEF0OiB3YWl0VmFsdWUudXBkYXRlZEF0LFxuICAgICAgICAgICAgc3BlY1ZlcnNpb246IHdhaXRWYWx1ZS5zcGVjVmVyc2lvbiA/PyB1bmRlZmluZWQsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgIGBXYWl0IFwiJHtkYXRhLmNvcnJlbGF0aW9uSWR9XCIgYWxyZWFkeSBleGlzdHNgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBIYW5kbGUgd2FpdF9jb21wbGV0ZWQgZXZlbnQ6IHRyYW5zaXRpb24gd2FpdCB0byAnY29tcGxldGVkJ1xuICAgICAgLy8gVXNlcyBjb25kaXRpb25hbCBVUERBVEUgdG8gcmVqZWN0IGR1cGxpY2F0ZSBjb21wbGV0aW9ucyAoc2FtZSBwYXR0ZXJuIGFzIHN0ZXBfY29tcGxldGVkKVxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAnd2FpdF9jb21wbGV0ZWQnKSB7XG4gICAgICAgIGNvbnN0IHdhaXRJZCA9IGAke2VmZmVjdGl2ZVJ1bklkfS0ke2RhdGEuY29ycmVsYXRpb25JZH1gO1xuICAgICAgICBjb25zdCBbd2FpdFZhbHVlXSA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgICAudXBkYXRlKFNjaGVtYS53YWl0cylcbiAgICAgICAgICAuc2V0KHtcbiAgICAgICAgICAgIHN0YXR1czogJ2NvbXBsZXRlZCcsXG4gICAgICAgICAgICBjb21wbGV0ZWRBdDogbm93LFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLndoZXJlKFxuICAgICAgICAgICAgYW5kKFxuICAgICAgICAgICAgICBlcShTY2hlbWEud2FpdHMud2FpdElkLCB3YWl0SWQpLFxuICAgICAgICAgICAgICBlcShTY2hlbWEud2FpdHMuc3RhdHVzLCAnd2FpdGluZycpXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICAgIC5yZXR1cm5pbmcoKTtcbiAgICAgICAgaWYgKHdhaXRWYWx1ZSkge1xuICAgICAgICAgIHdhaXQgPSB7XG4gICAgICAgICAgICB3YWl0SWQ6IHdhaXRWYWx1ZS53YWl0SWQsXG4gICAgICAgICAgICBydW5JZDogd2FpdFZhbHVlLnJ1bklkLFxuICAgICAgICAgICAgc3RhdHVzOiB3YWl0VmFsdWUuc3RhdHVzLFxuICAgICAgICAgICAgcmVzdW1lQXQ6IHdhaXRWYWx1ZS5yZXN1bWVBdCA/PyB1bmRlZmluZWQsXG4gICAgICAgICAgICBjb21wbGV0ZWRBdDogd2FpdFZhbHVlLmNvbXBsZXRlZEF0ID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIGNyZWF0ZWRBdDogd2FpdFZhbHVlLmNyZWF0ZWRBdCxcbiAgICAgICAgICAgIHVwZGF0ZWRBdDogd2FpdFZhbHVlLnVwZGF0ZWRBdCxcbiAgICAgICAgICAgIHNwZWNWZXJzaW9uOiB3YWl0VmFsdWUuc3BlY1ZlcnNpb24gPz8gdW5kZWZpbmVkLFxuICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gV2FpdCBub3QgdXBkYXRlZCAtIGNoZWNrIGlmIGl0IGV4aXN0cyBhbmQgd2h5XG4gICAgICAgICAgY29uc3QgW2V4aXN0aW5nXSA9IGF3YWl0IGdldFdhaXRGb3JWYWxpZGF0aW9uLmV4ZWN1dGUoe1xuICAgICAgICAgICAgd2FpdElkLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBXb3JrZmxvd1dvcmxkRXJyb3IoXG4gICAgICAgICAgICAgIGBXYWl0IFwiJHtkYXRhLmNvcnJlbGF0aW9uSWR9XCIgbm90IGZvdW5kYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGV4aXN0aW5nLnN0YXR1cyA9PT0gJ2NvbXBsZXRlZCcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgICAgICBgV2FpdCBcIiR7ZGF0YS5jb3JyZWxhdGlvbklkfVwiIGFscmVhZHkgY29tcGxldGVkYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICAgIGNvbnN0IGluc2VydGVkID0gYXdhaXQgaW5zZXJ0RXZlbnRSb3coZHJpenpsZSwge1xuICAgICAgICAgICAgcnVuSWQ6IGVmZmVjdGl2ZVJ1bklkLFxuICAgICAgICAgICAgZXZlbnRJZDogYXdhaXQgZ2V0RXZlbnRJZCgpLFxuICAgICAgICAgICAgY29ycmVsYXRpb25JZDogZGF0YS5jb3JyZWxhdGlvbklkLFxuICAgICAgICAgICAgZXZlbnRUeXBlOiBkYXRhLmV2ZW50VHlwZSxcbiAgICAgICAgICAgIGV2ZW50RGF0YTogc3RvcmVkRXZlbnREYXRhLFxuICAgICAgICAgICAgc3BlY1ZlcnNpb246IGVmZmVjdGl2ZVNwZWNWZXJzaW9uLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChpbnNlcnRlZCkge1xuICAgICAgICAgICAgZXZlbnRJZCA9IGluc2VydGVkLmV2ZW50SWQ7XG4gICAgICAgICAgICB2YWx1ZSA9IHsgY3JlYXRlZEF0OiBpbnNlcnRlZC5jcmVhdGVkQXQgfTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvLyBUcmFuc2xhdGUgdW5pcXVlLXZpb2xhdGlvbiBvbiB0aGUgY29ycmVsYXRlZC1ldmVudCBwYXJ0aWFsIGluZGV4XG4gICAgICAgIC8vICh3b3JrZmxvd19ldmVudHNfZW50aXR5X2NyZWF0aW9uX3VuaXF1ZSkgaW50byBFbnRpdHlDb25mbGljdEVycm9yXG4gICAgICAgIC8vIHNvIHRoZSBydW50aW1lJ3MgZXhpc3RpbmcgZGVkdXAgY2F0Y2ggcGF0aCBjYW4gaGFuZGxlIGl0LiBXaXRob3V0XG4gICAgICAgIC8vIHRoaXMsIHR3byBjb25jdXJyZW50IGludm9jYXRpb25zIHByb2R1Y2luZyBpZGVudGljYWxcbiAgICAgICAgLy8gY29ycmVsYXRpb25JZHMgKGUuZy4gc25hcHNob3QgcnVudGltZSBkZXRlcm1pbmlzdGljIFVMSURzKSB3b3VsZFxuICAgICAgICAvLyBzdXJmYWNlIGFzIHVuaGFuZGxlZCBEQiBlcnJvcnMgaW5zdGVhZCBvZiBkZWR1cCBzaWduYWxzLlxuICAgICAgICAvLyBEcml6emxlIHdyYXBzIHRoZSB1bmRlcmx5aW5nIHBnIGVycm9yIGluIERyaXp6bGVRdWVyeUVycm9yOyB0aGVcbiAgICAgICAgLy8gcGcgZXJyb3IgKHdpdGggLmNvZGUgPT09ICcyMzUwNScpIGxpdmVzIG9uIC5jYXVzZS4gV2UgYWRkaXRpb25hbGx5XG4gICAgICAgIC8vIGdhdGUgb24gdGhlIHZpb2xhdGVkIGNvbnN0cmFpbnQgbmFtZSBzbyBvdGhlciAyMzUwNSB2aW9sYXRpb25zIG9uXG4gICAgICAgIC8vIHRoZXNlIGV2ZW50IHR5cGVzIChlLmcuIHRoZSBldmVudHMgcHJpbWFyeSBrZXksIG9yIGFueSBmdXR1cmVcbiAgICAgICAgLy8gdW5pcXVlIGNvbnN0cmFpbnQgd2UgbWlnaHQgYWRkKSBkb24ndCBnZXQgbWlzY2xhc3NpZmllZCBhcyBhXG4gICAgICAgIC8vIGNvcnJlbGF0aW9uSWQgY29uZmxpY3QuXG4gICAgICAgIGNvbnN0IGlzRGVkdXBsaWNhdGVkQ29ycmVsYXRlZEV2ZW50ID1cbiAgICAgICAgICBpc0NoaWxkRW50aXR5Q3JlYXRpb25FdmVudFR5cGUoZGF0YS5ldmVudFR5cGUpIHx8XG4gICAgICAgICAgKGRhdGEuZXZlbnRUeXBlID09PSAnYXR0cl9zZXQnICYmXG4gICAgICAgICAgICBkYXRhLmV2ZW50RGF0YS53cml0ZXIudHlwZSA9PT0gJ3dvcmtmbG93Jyk7XG4gICAgICAgIGNvbnN0IHBnRXJyID0gcGdFcnJvck9mKGVycik7XG4gICAgICAgIGNvbnN0IHBnQ29kZSA9IHBnRXJyLmNvZGU7XG4gICAgICAgIGNvbnN0IHBnQ29uc3RyYWludCA9IHBnRXJyLmNvbnN0cmFpbnQ7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBpc0RlZHVwbGljYXRlZENvcnJlbGF0ZWRFdmVudCAmJlxuICAgICAgICAgIHBnQ29kZSA9PT0gJzIzNTA1JyAmJlxuICAgICAgICAgIHBnQ29uc3RyYWludCA9PT0gJ3dvcmtmbG93X2V2ZW50c19lbnRpdHlfY3JlYXRpb25fdW5pcXVlJ1xuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRW50aXR5Q29uZmxpY3RFcnJvcihcbiAgICAgICAgICAgIGAke2RhdGEuZXZlbnRUeXBlfSBmb3IgY29ycmVsYXRpb25JZCBcIiR7ZGF0YS5jb3JyZWxhdGlvbklkfVwiIGFscmVhZHkgZXhpc3RzIGluIHJ1biBcIiR7ZWZmZWN0aXZlUnVuSWR9XCJgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9XG4gICAgICBpZiAoIXZhbHVlIHx8ICFldmVudElkKSB7XG4gICAgICAgIHRocm93IG5ldyBFbnRpdHlDb25mbGljdEVycm9yKFxuICAgICAgICAgIGAke2RhdGEuZXZlbnRUeXBlfSBmb3IgcnVuIFwiJHtlZmZlY3RpdmVSdW5JZH1cIiBjb3VsZCBub3QgYmUgY3JlYXRlZGBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHtcbiAgICAgICAgLi4uZGF0YSxcbiAgICAgICAgLi4udmFsdWUsXG4gICAgICAgIHJ1bklkOiBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgZXZlbnRJZCxcbiAgICAgICAgLi4uKHN0b3JlZEV2ZW50RGF0YSAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgPyB7IGV2ZW50RGF0YTogc3RvcmVkRXZlbnREYXRhIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH07XG4gICAgICAvLyBTdHJpcCBldmVudERhdGEgbGVha2VkIGJ5IC4uLmRhdGEgc3ByZWFkIGZvciBydW5fc3RhcnRlZCBldmVudHMuXG4gICAgICAvLyBUaGUgZXZlbnREYXRhIChydW4gaW5wdXQgZm9yIHJlc2lsaWVudCBzdGFydCkgYmVsb25ncyBvblxuICAgICAgLy8gcnVuX2NyZWF0ZWQgb25seTsgc3RvcmVkRXZlbnREYXRhIGlzIGFscmVhZHkgdW5kZWZpbmVkIGFib3ZlLlxuICAgICAgaWYgKGRhdGEuZXZlbnRUeXBlID09PSAncnVuX3N0YXJ0ZWQnKSB7XG4gICAgICAgIGRlbGV0ZSAocmVzdWx0IGFzIGFueSkuZXZlbnREYXRhO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFyc2VkID0gRXZlbnRTY2hlbWEucGFyc2UocmVzdWx0KTtcbiAgICAgIGNvbnN0IHJlc29sdmVEYXRhID0gcGFyYW1zPy5yZXNvbHZlRGF0YSA/PyAnYWxsJztcblxuICAgICAgLy8gRm9yIHJ1bl9zdGFydGVkOiBpbmNsdWRlIGFsbCBldmVudHMgc28gdGhlIHJ1bnRpbWUgY2FuIHNraXBcbiAgICAgIC8vIHRoZSBpbml0aWFsIGV2ZW50cy5saXN0IGNhbGwgYW5kIHJlZHVjZSBUVEZCLlxuICAgICAgbGV0IGV2ZW50UGFnZTogUGFnaW5hdGVkUmVzcG9uc2U8RXZlbnQ+IHwgdW5kZWZpbmVkO1xuICAgICAgLy8gVGhlIHNraXBwZWQtc2xvdCByZXBvcnQgYW5kIHRoZSBpbmxpbmUgZGVsdGEgYmVsb3cgc2hhcmVcbiAgICAgIC8vIGBldmVudHNgL2BjdXJzb3JgL2BoYXNNb3JlYCwgYW5kIHRoZSBydW50aW1lIHNlbmRzIGJvdGggb24gdGhlIHNhbWVcbiAgICAgIC8vIHdyaXRlLiBUaGUgZGVsdGEgd2luczogdGhlIHNraXBwZWQgc2xvdHMgYWxsIHNpdCBhYm92ZSB0aGUgY3Vyc29yLCBzb1xuICAgICAgLy8gaXQgaXMgYSBzdHJpY3Qgc3VwZXJzZXQsIGFuZCBpdCBpcyB0aGUgb25seSBvbmUgb2YgdGhlIHR3byB0aGF0XG4gICAgICAvLyBhZHZhbmNlcyBgY3Vyc29yYC4gUnVubmluZyB0aGUgcmVwb3J0IGFueXdheSB3b3VsZCBjb3N0IGEgcXVlcnkgd2hvc2VcbiAgICAgIC8vIHJlc3VsdCB0aGUgZGVsdGEgb3ZlcndyaXRlcy5cbiAgICAgIGlmIChcbiAgICAgICAgcGFyYW1zPy5ldmVudENvdW50ICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgdHlwZW9mIHBhcmFtcy5zaW5jZUN1cnNvciAhPT0gJ3N0cmluZydcbiAgICAgICkge1xuICAgICAgICBjb25zdCByZXBvcnQgPSBhd2FpdCByZXBvcnRTa2lwcGVkU2xvdHMoXG4gICAgICAgICAgZHJpenpsZSxcbiAgICAgICAgICBlZmZlY3RpdmVSdW5JZCxcbiAgICAgICAgICBwYXJzZWQuZXZlbnRJZCxcbiAgICAgICAgICBwYXJhbXMuZXZlbnRDb3VudCxcbiAgICAgICAgICByZXNvbHZlRGF0YVxuICAgICAgICApO1xuICAgICAgICBpZiAocmVwb3J0KSB7XG4gICAgICAgICAgLy8gRGVsaWJlcmF0ZWx5IG5vIGN1cnNvcjogdGhlIHJlcG9ydCBpcyBhIGxvd2VyIGJvdW5kIG9uIHdoYXQgdGhpc1xuICAgICAgICAgIC8vIHdyaXRlIHNraXBwZWQgb3Zlciwgbm90IGEgcGFnZSB0aGUgY2FsbGVyIGhhcyBub3cgcmVhZCB0byB0aGUgZW5kXG4gICAgICAgICAgLy8gb2YsIHNvIGl0IG11c3Qgbm90IGFkdmFuY2UgdGhlIGNhbGxlcidzIHJlYWQgcG9zaXRpb24uXG4gICAgICAgICAgZXZlbnRQYWdlID0ge1xuICAgICAgICAgICAgZGF0YTogcmVwb3J0LmV2ZW50cyxcbiAgICAgICAgICAgIGN1cnNvcjogbnVsbCxcbiAgICAgICAgICAgIGhhc01vcmU6IHJlcG9ydC5oYXNNb3JlLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChkYXRhLmV2ZW50VHlwZSA9PT0gJ3J1bl9zdGFydGVkJyAmJiBydW4gJiYgIXBhcmFtcz8uc2tpcFByZWxvYWQpIHtcbiAgICAgICAgY29uc3QgZXZlbnRSb3dzID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgIC5zZWxlY3QoKVxuICAgICAgICAgIC5mcm9tKFNjaGVtYS5ldmVudHMpXG4gICAgICAgICAgLndoZXJlKGVxKFNjaGVtYS5ldmVudHMucnVuSWQsIGVmZmVjdGl2ZVJ1bklkKSlcbiAgICAgICAgICAub3JkZXJCeShTY2hlbWEuZXZlbnRzLmV2ZW50SWQpO1xuICAgICAgICBjb25zdCBkYXRhID0gZXZlbnRSb3dzLm1hcCgoZSkgPT4ge1xuICAgICAgICAgIGUuZXZlbnREYXRhIHx8PSBlLmV2ZW50RGF0YUpzb247XG4gICAgICAgICAgY29uc3QgcGFyc2VkID0gRXZlbnRTY2hlbWEucGFyc2UoY29tcGFjdChlKSk7XG4gICAgICAgICAgcmV0dXJuIHN0cmlwRXZlbnREYXRhUmVmcyhwYXJzZWQsIHJlc29sdmVEYXRhKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGV2ZW50UGFnZSA9IHtcbiAgICAgICAgICBkYXRhLFxuICAgICAgICAgIGN1cnNvcjogZGF0YS5hdCgtMSk/LmV2ZW50SWQgPz8gbnVsbCxcbiAgICAgICAgICBoYXNNb3JlOiBmYWxzZSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gSW5saW5lIGRlbHRhOiB0aGUgY2FsbGVyIHRvbGQgdXMgdGhlIGN1cnNvciBvZiB0aGUgbG9nIGl0IGhvbGRzLCBzb1xuICAgICAgLy8gcmV0dXJuIHRoZSBwYWdlIGBldmVudHMubGlzdCh7IGN1cnNvcjogc2luY2VDdXJzb3IsIHNvcnRPcmRlcjogJ2FzYycgfSlgXG4gICAgICAvLyB3b3VsZCByZXR1cm4gcmlnaHQgbm93IGFuZCBzYXZlIGl0IHRoZSByb3VuZC10cmlwLiBTYW1lIHF1ZXJ5LCBzYW1lXG4gICAgICAvLyBwYWdlIHNpemUsIHNhbWUgY3Vyc29yIHNlbWFudGljcyBhcyBgbGlzdGAgYmVsb3cg4oCUIGRlbGliZXJhdGVseSBub3RcbiAgICAgIC8vIHBhZ2luYXRlZCB0byBleGhhdXN0aW9uLCBzaW5jZSB0aGUgY29udHJhY3QgaXNcbiAgICAgIC8vIHNpbmdsZS1wYWdlLW9yLWZhbGwtYmFjayBhbmQgdGhlIGNhbGxlciBpZ25vcmVzIGEgZGVsdGEgd2l0aFxuICAgICAgLy8gYGhhc01vcmU6IHRydWVgLlxuICAgICAgaWYgKHR5cGVvZiBwYXJhbXM/LnNpbmNlQ3Vyc29yID09PSAnc3RyaW5nJykge1xuICAgICAgICBjb25zdCBsaW1pdCA9IDEwMDtcbiAgICAgICAgY29uc3QgZGVsdGFSb3dzID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAgIC5zZWxlY3QoKVxuICAgICAgICAgIC5mcm9tKFNjaGVtYS5ldmVudHMpXG4gICAgICAgICAgLndoZXJlKFxuICAgICAgICAgICAgYW5kKFxuICAgICAgICAgICAgICBlcShTY2hlbWEuZXZlbnRzLnJ1bklkLCBlZmZlY3RpdmVSdW5JZCksXG4gICAgICAgICAgICAgIGd0KFNjaGVtYS5ldmVudHMuZXZlbnRJZCwgcGFyYW1zLnNpbmNlQ3Vyc29yKVxuICAgICAgICAgICAgKVxuICAgICAgICAgIClcbiAgICAgICAgICAub3JkZXJCeShTY2hlbWEuZXZlbnRzLmV2ZW50SWQpXG4gICAgICAgICAgLmxpbWl0KGxpbWl0ICsgMSk7XG4gICAgICAgIGNvbnN0IHBhZ2UgPSBkZWx0YVJvd3Muc2xpY2UoMCwgbGltaXQpO1xuICAgICAgICBjb25zdCBkYXRhID0gcGFnZS5tYXAoKGUpID0+IHtcbiAgICAgICAgICBlLmV2ZW50RGF0YSB8fD0gZS5ldmVudERhdGFKc29uO1xuICAgICAgICAgIHJldHVybiBzdHJpcEV2ZW50RGF0YVJlZnMoRXZlbnRTY2hlbWEucGFyc2UoY29tcGFjdChlKSksIHJlc29sdmVEYXRhKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGV2ZW50UGFnZSA9IHtcbiAgICAgICAgICBkYXRhLFxuICAgICAgICAgIGN1cnNvcjogZGF0YS5hdCgtMSk/LmV2ZW50SWQgPz8gbnVsbCxcbiAgICAgICAgICBoYXNNb3JlOiBkZWx0YVJvd3MubGVuZ3RoID4gbGltaXQsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGV2ZW50UmVzdWx0OiBFdmVudFJlc3VsdCA9IHtcbiAgICAgICAgZXZlbnQ6IHN0cmlwRXZlbnREYXRhUmVmcyhwYXJzZWQsIHJlc29sdmVEYXRhKSxcbiAgICAgICAgcnVuLFxuICAgICAgICBzdGVwLFxuICAgICAgICBob29rLFxuICAgICAgICB3YWl0LFxuICAgICAgICAuLi4oc3RlcENyZWF0ZWRMYXppbHkgPyB7IHN0ZXBDcmVhdGVkOiB0cnVlIH0gOiB7fSksXG4gICAgICB9O1xuXG4gICAgICBpZiAoIWV2ZW50UGFnZSkgcmV0dXJuIGV2ZW50UmVzdWx0O1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICAuLi5ldmVudFJlc3VsdCxcbiAgICAgICAgZXZlbnRzOiBldmVudFBhZ2UuZGF0YSxcbiAgICAgICAgY3Vyc29yOiBldmVudFBhZ2UuY3Vyc29yLFxuICAgICAgICBoYXNNb3JlOiBldmVudFBhZ2UuaGFzTW9yZSxcbiAgICAgIH07XG4gICAgfSxcbiAgICBhc3luYyBnZXQoXG4gICAgICBydW5JZDogc3RyaW5nLFxuICAgICAgZXZlbnRJZDogc3RyaW5nLFxuICAgICAgcGFyYW1zPzogR2V0RXZlbnRQYXJhbXNcbiAgICApOiBQcm9taXNlPEV2ZW50PiB7XG4gICAgICBjb25zdCBbdmFsdWVdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAuc2VsZWN0KClcbiAgICAgICAgLmZyb20oZXZlbnRzKVxuICAgICAgICAud2hlcmUoYW5kKGVxKGV2ZW50cy5ydW5JZCwgcnVuSWQpLCBlcShldmVudHMuZXZlbnRJZCwgZXZlbnRJZCkpKVxuICAgICAgICAubGltaXQoMSk7XG5cbiAgICAgIGlmICghdmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93V29ybGRFcnJvcihgRXZlbnQgbm90IGZvdW5kOiAke2V2ZW50SWR9YCk7XG4gICAgICB9XG5cbiAgICAgIHZhbHVlLmV2ZW50RGF0YSB8fD0gdmFsdWUuZXZlbnREYXRhSnNvbjtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEV2ZW50U2NoZW1hLnBhcnNlKGNvbXBhY3QodmFsdWUpKTtcbiAgICAgIGNvbnN0IHJlc29sdmVEYXRhID0gcGFyYW1zPy5yZXNvbHZlRGF0YSA/PyAnYWxsJztcbiAgICAgIHJldHVybiBzdHJpcEV2ZW50RGF0YVJlZnMocGFyc2VkLCByZXNvbHZlRGF0YSk7XG4gICAgfSxcbiAgICBhc3luYyBsaXN0KHBhcmFtczogTGlzdEV2ZW50c1BhcmFtcyk6IFByb21pc2U8UGFnaW5hdGVkUmVzcG9uc2U8RXZlbnQ+PiB7XG4gICAgICBjb25zdCBsaW1pdCA9IHBhcmFtcy5wYWdpbmF0aW9uPy5saW1pdCA/PyBnZXRNYXhFdmVudHNQZXJSdW4oKTtcbiAgICAgIGNvbnN0IHNvcnRPcmRlciA9IHBhcmFtcy5wYWdpbmF0aW9uPy5zb3J0T3JkZXIgPz8gJ2FzYyc7XG4gICAgICBjb25zdCBvcmRlciA9XG4gICAgICAgIHNvcnRPcmRlciA9PT0gJ2Rlc2MnXG4gICAgICAgICAgPyB7IGJ5OiBkZXNjKGV2ZW50cy5ldmVudElkKSwgY29tcGFyZTogbHQgfVxuICAgICAgICAgIDogeyBieTogZXZlbnRzLmV2ZW50SWQsIGNvbXBhcmU6IGd0IH07XG4gICAgICBjb25zdCByZXNvbHZlRGF0YSA9IHBhcmFtcy5yZXNvbHZlRGF0YSA/PyAnYWxsJztcbiAgICAgIGNvbnN0IGRhdGE6IEV2ZW50W10gPSBbXTtcbiAgICAgIGxldCBjdXJzb3IgPSBwYXJhbXMucGFnaW5hdGlvbj8uY3Vyc29yO1xuICAgICAgbGV0IGhhc01vcmUgPSBmYWxzZTtcblxuICAgICAgZG8ge1xuICAgICAgICBjb25zdCBwYWdlTGltaXQgPVxuICAgICAgICAgIHBhcmFtcy5wYWdpbmF0aW9uPy5saW1pdCA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICA/IE1hdGgubWluKDUwMCwgbGltaXQgLSBkYXRhLmxlbmd0aClcbiAgICAgICAgICAgIDogbGltaXQ7XG4gICAgICAgIGNvbnN0IHJvd3MgPSBhd2FpdCBkcml6emxlXG4gICAgICAgICAgLnNlbGVjdCgpXG4gICAgICAgICAgLmZyb20oZXZlbnRzKVxuICAgICAgICAgIC53aGVyZShcbiAgICAgICAgICAgIGFuZChcbiAgICAgICAgICAgICAgZXEoZXZlbnRzLnJ1bklkLCBwYXJhbXMucnVuSWQpLFxuICAgICAgICAgICAgICBtYXAoY3Vyc29yLCAodmFsdWUpID0+IG9yZGVyLmNvbXBhcmUoZXZlbnRzLmV2ZW50SWQsIHZhbHVlKSlcbiAgICAgICAgICAgIClcbiAgICAgICAgICApXG4gICAgICAgICAgLm9yZGVyQnkob3JkZXIuYnkpXG4gICAgICAgICAgLmxpbWl0KHBhZ2VMaW1pdCArIDEpO1xuICAgICAgICBjb25zdCBwYWdlID0gcm93cy5zbGljZSgwLCBwYWdlTGltaXQpO1xuXG4gICAgICAgIGZvciAoY29uc3Qgcm93IG9mIHBhZ2UpIHtcbiAgICAgICAgICByb3cuZXZlbnREYXRhIHx8PSByb3cuZXZlbnREYXRhSnNvbjtcbiAgICAgICAgICBjb25zdCBldmVudCA9IEV2ZW50U2NoZW1hLnBhcnNlKGNvbXBhY3Qocm93KSk7XG4gICAgICAgICAgZGF0YS5wdXNoKHN0cmlwRXZlbnREYXRhUmVmcyhldmVudCwgcmVzb2x2ZURhdGEpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGN1cnNvciA9IHBhZ2UuYXQoLTEpPy5ldmVudElkO1xuICAgICAgICBoYXNNb3JlID0gcm93cy5sZW5ndGggPiBwYWdlTGltaXQ7XG4gICAgICB9IHdoaWxlIChcbiAgICAgICAgcGFyYW1zLnBhZ2luYXRpb24/LmxpbWl0ID09PSB1bmRlZmluZWQgJiZcbiAgICAgICAgaGFzTW9yZSAmJlxuICAgICAgICBkYXRhLmxlbmd0aCA8IGxpbWl0XG4gICAgICApO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBkYXRhLFxuICAgICAgICBjdXJzb3I6IGRhdGEuYXQoLTEpPy5ldmVudElkID8/IG51bGwsXG4gICAgICAgIGhhc01vcmUsXG4gICAgICB9O1xuICAgIH0sXG4gICAgYXN5bmMgbGlzdEJ5Q29ycmVsYXRpb25JZChwYXJhbXMpIHtcbiAgICAgIGNvbnN0IGxpbWl0ID0gcGFyYW1zPy5wYWdpbmF0aW9uPy5saW1pdCA/PyAxMDA7XG4gICAgICBjb25zdCBzb3J0T3JkZXIgPSBwYXJhbXMucGFnaW5hdGlvbj8uc29ydE9yZGVyIHx8ICdhc2MnO1xuICAgICAgY29uc3Qgb3JkZXIgPVxuICAgICAgICBzb3J0T3JkZXIgPT09ICdkZXNjJ1xuICAgICAgICAgID8geyBieTogZGVzYyhldmVudHMuZXZlbnRJZCksIGNvbXBhcmU6IGx0IH1cbiAgICAgICAgICA6IHsgYnk6IGV2ZW50cy5ldmVudElkLCBjb21wYXJlOiBndCB9O1xuICAgICAgY29uc3QgYWxsID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAuc2VsZWN0KClcbiAgICAgICAgLmZyb20oZXZlbnRzKVxuICAgICAgICAud2hlcmUoXG4gICAgICAgICAgYW5kKFxuICAgICAgICAgICAgZXEoZXZlbnRzLmNvcnJlbGF0aW9uSWQsIHBhcmFtcy5jb3JyZWxhdGlvbklkKSxcbiAgICAgICAgICAgIC8vIEEgY29ycmVsYXRpb24gaWQgbmFtZXMgYSBzdGVwIG9yIHdhaXQgd2l0aGluIGl0cyBydW4sIHNvIGFuXG4gICAgICAgICAgICAvLyB1bnNjb3BlZCBxdWVyeSBtYXRjaGVzIG9uZSBldmVudCBwZXIgcnVuIHRoYXQgYWxsb2NhdGVkIHRoZSBzYW1lXG4gICAgICAgICAgICAvLyBpZCDigJQgYW5kIHRoZSBjdXJzb3IsIGFuIGV2ZW50IGlkLCBjYW5ub3QgdGVsbCB0d28gc3VjaCByb3dzXG4gICAgICAgICAgICAvLyBhcGFydC4gU2NvcGVkLCBgKHJ1bl9pZCwgaWQpYCBpcyB0aGUgcHJpbWFyeSBrZXksIHNvIGl0IGNhbi5cbiAgICAgICAgICAgIGVxKGV2ZW50cy5ydW5JZCwgcGFyYW1zLnJ1bklkKSxcbiAgICAgICAgICAgIG1hcChwYXJhbXMucGFnaW5hdGlvbj8uY3Vyc29yLCAoYykgPT5cbiAgICAgICAgICAgICAgb3JkZXIuY29tcGFyZShldmVudHMuZXZlbnRJZCwgYylcbiAgICAgICAgICAgIClcbiAgICAgICAgICApXG4gICAgICAgIClcbiAgICAgICAgLm9yZGVyQnkob3JkZXIuYnkpXG4gICAgICAgIC5saW1pdChsaW1pdCArIDEpO1xuXG4gICAgICBjb25zdCB2YWx1ZXMgPSBhbGwuc2xpY2UoMCwgbGltaXQpO1xuXG4gICAgICBjb25zdCByZXNvbHZlRGF0YSA9IHBhcmFtcz8ucmVzb2x2ZURhdGEgPz8gJ2FsbCc7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBkYXRhOiB2YWx1ZXMubWFwKCh2KSA9PiB7XG4gICAgICAgICAgdi5ldmVudERhdGEgfHw9IHYuZXZlbnREYXRhSnNvbjtcbiAgICAgICAgICBjb25zdCBwYXJzZWQgPSBFdmVudFNjaGVtYS5wYXJzZShjb21wYWN0KHYpKTtcbiAgICAgICAgICByZXR1cm4gc3RyaXBFdmVudERhdGFSZWZzKHBhcnNlZCwgcmVzb2x2ZURhdGEpO1xuICAgICAgICB9KSxcbiAgICAgICAgY3Vyc29yOiB2YWx1ZXMuYXQoLTEpPy5ldmVudElkID8/IG51bGwsXG4gICAgICAgIGhhc01vcmU6IGFsbC5sZW5ndGggPiBsaW1pdCxcbiAgICAgIH07XG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUhvb2tzU3RvcmFnZShkcml6emxlOiBEcml6emxlKTogU3RvcmFnZVsnaG9va3MnXSB7XG4gIGNvbnN0IHsgaG9va3MsIHJ1bnMgfSA9IFNjaGVtYTtcbiAgY29uc3Qgb3duZXJSdW5Jc1Rlcm1pbmFsID0gZHJpenpsZVxuICAgIC5zZWxlY3QoeyBydW5JZDogcnVucy5ydW5JZCB9KVxuICAgIC5mcm9tKHJ1bnMpXG4gICAgLndoZXJlKFxuICAgICAgYW5kKFxuICAgICAgICBlcShydW5zLnJ1bklkLCBob29rcy5ydW5JZCksXG4gICAgICAgIGluQXJyYXkocnVucy5zdGF0dXMsIFRFUk1JTkFMX1dPUktGTE9XX1JVTl9TVEFUVVNFUylcbiAgICAgIClcbiAgICApO1xuICBjb25zdCBhdmFpbGFibGUgPSBvcihcbiAgICBndChob29rcy50b2tlblJldGVudGlvblVudGlsLCBzcWxgbm93KClgKSxcbiAgICBub3RFeGlzdHMob3duZXJSdW5Jc1Rlcm1pbmFsKVxuICApO1xuICBjb25zdCBnZXRCeVRva2VuID0gZHJpenpsZVxuICAgIC5zZWxlY3QoKVxuICAgIC5mcm9tKGhvb2tzKVxuICAgIC53aGVyZShhbmQoZXEoaG9va3MudG9rZW4sIHNxbC5wbGFjZWhvbGRlcigndG9rZW4nKSksIGF2YWlsYWJsZSkpXG4gICAgLmxpbWl0KDEpXG4gICAgLnByZXBhcmUoJ3dvcmtmbG93X2hvb2tzX2dldF9ieV90b2tlbicpO1xuXG4gIHJldHVybiB7XG4gICAgYXN5bmMgZ2V0KGhvb2tJZCwgcGFyYW1zKSB7XG4gICAgICBjb25zdCBbdmFsdWVdID0gYXdhaXQgZHJpenpsZVxuICAgICAgICAuc2VsZWN0KClcbiAgICAgICAgLmZyb20oaG9va3MpXG4gICAgICAgIC53aGVyZShhbmQoZXEoaG9va3MuaG9va0lkLCBob29rSWQpLCBhdmFpbGFibGUpKVxuICAgICAgICAubGltaXQoMSk7XG4gICAgICBpZiAoIXZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBIb29rTm90Rm91bmRFcnJvcihob29rSWQpO1xuICAgICAgfVxuICAgICAgdmFsdWUubWV0YWRhdGEgfHw9IHZhbHVlLm1ldGFkYXRhSnNvbjtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEhvb2tTY2hlbWEucGFyc2UoY29tcGFjdCh2YWx1ZSkpO1xuICAgICAgcGFyc2VkLmlzV2ViaG9vayA/Pz0gdHJ1ZTtcbiAgICAgIGNvbnN0IHJlc29sdmVEYXRhID0gcGFyYW1zPy5yZXNvbHZlRGF0YSA/PyAnYWxsJztcbiAgICAgIHJldHVybiBmaWx0ZXJIb29rRGF0YShwYXJzZWQsIHJlc29sdmVEYXRhKTtcbiAgICB9LFxuICAgIGFzeW5jIGdldEJ5VG9rZW4odG9rZW4sIHBhcmFtcykge1xuICAgICAgY29uc3QgW3ZhbHVlXSA9IGF3YWl0IGdldEJ5VG9rZW4uZXhlY3V0ZSh7IHRva2VuIH0pO1xuICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgSG9va05vdEZvdW5kRXJyb3IodG9rZW4pO1xuICAgICAgfVxuICAgICAgdmFsdWUubWV0YWRhdGEgfHw9IHZhbHVlLm1ldGFkYXRhSnNvbjtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEhvb2tTY2hlbWEucGFyc2UoY29tcGFjdCh2YWx1ZSkpO1xuICAgICAgcGFyc2VkLmlzV2ViaG9vayA/Pz0gdHJ1ZTtcbiAgICAgIGNvbnN0IHJlc29sdmVEYXRhID0gcGFyYW1zPy5yZXNvbHZlRGF0YSA/PyAnYWxsJztcbiAgICAgIHJldHVybiBmaWx0ZXJIb29rRGF0YShwYXJzZWQsIHJlc29sdmVEYXRhKTtcbiAgICB9LFxuICAgIGFzeW5jIGxpc3QocGFyYW1zOiBMaXN0SG9va3NQYXJhbXMpIHtcbiAgICAgIGNvbnN0IGxpbWl0ID0gcGFyYW1zPy5wYWdpbmF0aW9uPy5saW1pdCA/PyAxMDA7XG4gICAgICBjb25zdCBmcm9tQ3Vyc29yID0gcGFyYW1zPy5wYWdpbmF0aW9uPy5jdXJzb3I7XG4gICAgICBjb25zdCBzb3J0T3JkZXIgPSBwYXJhbXM/LnBhZ2luYXRpb24/LnNvcnRPcmRlciA/PyAnYXNjJztcbiAgICAgIGNvbnN0IG9yZGVyRm4gPSBzb3J0T3JkZXIgPT09ICdhc2MnID8gYXNjIDogZGVzYztcbiAgICAgIGNvbnN0IGN1cnNvckZuID0gc29ydE9yZGVyID09PSAnYXNjJyA/IGd0IDogbHQ7XG4gICAgICBjb25zdCBhbGwgPSBhd2FpdCBkcml6emxlXG4gICAgICAgIC5zZWxlY3QoKVxuICAgICAgICAuZnJvbShob29rcylcbiAgICAgICAgLndoZXJlKFxuICAgICAgICAgIGFuZChcbiAgICAgICAgICAgIGF2YWlsYWJsZSxcbiAgICAgICAgICAgIG1hcChwYXJhbXMucnVuSWQsIChpZCkgPT4gZXEoaG9va3MucnVuSWQsIGlkKSksXG4gICAgICAgICAgICBtYXAoZnJvbUN1cnNvciwgKGMpID0+IGN1cnNvckZuKGhvb2tzLmhvb2tJZCwgYykpXG4gICAgICAgICAgKVxuICAgICAgICApXG4gICAgICAgIC5vcmRlckJ5KG9yZGVyRm4oaG9va3MuaG9va0lkKSlcbiAgICAgICAgLmxpbWl0KGxpbWl0ICsgMSk7XG4gICAgICBjb25zdCB2YWx1ZXMgPSBhbGwuc2xpY2UoMCwgbGltaXQpO1xuICAgICAgY29uc3QgaGFzTW9yZSA9IGFsbC5sZW5ndGggPiBsaW1pdDtcblxuICAgICAgY29uc3QgcmVzb2x2ZURhdGEgPSBwYXJhbXM/LnJlc29sdmVEYXRhID8/ICdhbGwnO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGF0YTogdmFsdWVzLm1hcCgodikgPT4ge1xuICAgICAgICAgIHYubWV0YWRhdGEgfHw9IHYubWV0YWRhdGFKc29uO1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IEhvb2tTY2hlbWEucGFyc2UoY29tcGFjdCh2KSk7XG4gICAgICAgICAgcmV0dXJuIGZpbHRlckhvb2tEYXRhKHBhcnNlZCwgcmVzb2x2ZURhdGEpO1xuICAgICAgICB9KSxcbiAgICAgICAgY3Vyc29yOiB2YWx1ZXMuYXQoLTEpPy5ob29rSWQgPz8gbnVsbCxcbiAgICAgICAgaGFzTW9yZSxcbiAgICAgIH07XG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVN0ZXBzU3RvcmFnZShkcml6emxlOiBEcml6emxlKTogU3RvcmFnZVsnc3RlcHMnXSB7XG4gIGNvbnN0IHsgc3RlcHMgfSA9IFNjaGVtYTtcblxuICByZXR1cm4ge1xuICAgIGdldDogKGFzeW5jIChydW5JZCwgc3RlcElkLCBwYXJhbXMpID0+IHtcbiAgICAgIGNvbnN0IFt2YWx1ZV0gPSBhd2FpdCBkcml6emxlXG4gICAgICAgIC5zZWxlY3QoKVxuICAgICAgICAuZnJvbShzdGVwcylcbiAgICAgICAgLndoZXJlKGFuZChlcShzdGVwcy5ydW5JZCwgcnVuSWQpLCBlcShzdGVwcy5zdGVwSWQsIHN0ZXBJZCkpKVxuICAgICAgICAubGltaXQoMSk7XG5cbiAgICAgIGlmICghdmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93V29ybGRFcnJvcihgU3RlcCBub3QgZm91bmQ6ICR7c3RlcElkfWApO1xuICAgICAgfVxuICAgICAgdmFsdWUub3V0cHV0IHx8PSB2YWx1ZS5vdXRwdXRKc29uO1xuICAgICAgdmFsdWUuaW5wdXQgfHw9IHZhbHVlLmlucHV0SnNvbjtcbiAgICAgIHZhbHVlLmVycm9yIHx8PSBwYXJzZUVycm9ySnNvbih2YWx1ZS5lcnJvckpzb24pO1xuICAgICAgY29uc3QgZGVzZXJpYWxpemVkID0gZGVzZXJpYWxpemVTdGVwRXJyb3IoY29tcGFjdCh2YWx1ZSkpO1xuICAgICAgY29uc3QgcGFyc2VkID0gU3RlcFNjaGVtYS5wYXJzZShkZXNlcmlhbGl6ZWQpO1xuICAgICAgY29uc3QgcmVzb2x2ZURhdGEgPSBwYXJhbXM/LnJlc29sdmVEYXRhID8/ICdhbGwnO1xuICAgICAgcmV0dXJuIGZpbHRlclN0ZXBEYXRhKHBhcnNlZCwgcmVzb2x2ZURhdGEpO1xuICAgIH0pIGFzIFN0b3JhZ2VbJ3N0ZXBzJ11bJ2dldCddLFxuICAgIGxpc3Q6IChhc3luYyAocGFyYW1zKSA9PiB7XG4gICAgICBjb25zdCBsaW1pdCA9IHBhcmFtcz8ucGFnaW5hdGlvbj8ubGltaXQgPz8gMjA7XG4gICAgICBjb25zdCBmcm9tQ3Vyc29yID0gcGFyYW1zPy5wYWdpbmF0aW9uPy5jdXJzb3I7XG5cbiAgICAgIGNvbnN0IGFsbCA9IGF3YWl0IGRyaXp6bGVcbiAgICAgICAgLnNlbGVjdCgpXG4gICAgICAgIC5mcm9tKHN0ZXBzKVxuICAgICAgICAud2hlcmUoXG4gICAgICAgICAgYW5kKFxuICAgICAgICAgICAgZXEoc3RlcHMucnVuSWQsIHBhcmFtcy5ydW5JZCksXG4gICAgICAgICAgICBtYXAoZnJvbUN1cnNvciwgKGMpID0+IGx0KHN0ZXBzLnN0ZXBJZCwgYykpXG4gICAgICAgICAgKVxuICAgICAgICApXG4gICAgICAgIC5vcmRlckJ5KGRlc2Moc3RlcHMuc3RlcElkKSlcbiAgICAgICAgLmxpbWl0KGxpbWl0ICsgMSk7XG4gICAgICBjb25zdCB2YWx1ZXMgPSBhbGwuc2xpY2UoMCwgbGltaXQpO1xuICAgICAgY29uc3QgaGFzTW9yZSA9IGFsbC5sZW5ndGggPiBsaW1pdDtcblxuICAgICAgY29uc3QgcmVzb2x2ZURhdGEgPSBwYXJhbXM/LnJlc29sdmVEYXRhID8/ICdhbGwnO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGF0YTogdmFsdWVzLm1hcCgodikgPT4ge1xuICAgICAgICAgIHYub3V0cHV0IHx8PSB2Lm91dHB1dEpzb247XG4gICAgICAgICAgdi5pbnB1dCB8fD0gdi5pbnB1dEpzb247XG4gICAgICAgICAgdi5lcnJvciB8fD0gcGFyc2VFcnJvckpzb24odi5lcnJvckpzb24pO1xuICAgICAgICAgIGNvbnN0IGRlc2VyaWFsaXplZCA9IGRlc2VyaWFsaXplU3RlcEVycm9yKGNvbXBhY3QodikpO1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IFN0ZXBTY2hlbWEucGFyc2UoZGVzZXJpYWxpemVkKTtcbiAgICAgICAgICByZXR1cm4gZmlsdGVyU3RlcERhdGEocGFyc2VkLCByZXNvbHZlRGF0YSk7XG4gICAgICAgIH0pLFxuICAgICAgICBoYXNNb3JlLFxuICAgICAgICBjdXJzb3I6IHZhbHVlcy5hdCgtMSk/LnN0ZXBJZCA/PyBudWxsLFxuICAgICAgfTtcbiAgICB9KSBhcyBTdG9yYWdlWydzdGVwcyddWydsaXN0J10sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGZpbHRlclN0ZXBEYXRhKHN0ZXA6IFN0ZXAsIHJlc29sdmVEYXRhOiAnbm9uZScpOiBTdGVwV2l0aG91dERhdGE7XG5mdW5jdGlvbiBmaWx0ZXJTdGVwRGF0YShzdGVwOiBTdGVwLCByZXNvbHZlRGF0YTogJ2FsbCcpOiBTdGVwO1xuZnVuY3Rpb24gZmlsdGVyU3RlcERhdGEoXG4gIHN0ZXA6IFN0ZXAsXG4gIHJlc29sdmVEYXRhOiBSZXNvbHZlRGF0YVxuKTogU3RlcCB8IFN0ZXBXaXRob3V0RGF0YTtcbmZ1bmN0aW9uIGZpbHRlclN0ZXBEYXRhKFxuICBzdGVwOiBTdGVwLFxuICByZXNvbHZlRGF0YTogUmVzb2x2ZURhdGFcbik6IFN0ZXAgfCBTdGVwV2l0aG91dERhdGEge1xuICBpZiAocmVzb2x2ZURhdGEgPT09ICdub25lJykge1xuICAgIGNvbnN0IHsgaW5wdXQ6IF8sIG91dHB1dDogX18sIC4uLnJlc3QgfSA9IHN0ZXA7XG5cbiAgICByZXR1cm4geyBpbnB1dDogdW5kZWZpbmVkLCBvdXRwdXQ6IHVuZGVmaW5lZCwgLi4ucmVzdCB9O1xuICB9XG4gIHJldHVybiBzdGVwO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJSdW5EYXRhKFxuICBydW46IFdvcmtmbG93UnVuLFxuICByZXNvbHZlRGF0YTogJ25vbmUnXG4pOiBXb3JrZmxvd1J1bldpdGhvdXREYXRhO1xuZnVuY3Rpb24gZmlsdGVyUnVuRGF0YShydW46IFdvcmtmbG93UnVuLCByZXNvbHZlRGF0YTogJ2FsbCcpOiBXb3JrZmxvd1J1bjtcbmZ1bmN0aW9uIGZpbHRlclJ1bkRhdGEoXG4gIHJ1bjogV29ya2Zsb3dSdW4sXG4gIHJlc29sdmVEYXRhOiBSZXNvbHZlRGF0YVxuKTogV29ya2Zsb3dSdW4gfCBXb3JrZmxvd1J1bldpdGhvdXREYXRhO1xuZnVuY3Rpb24gZmlsdGVyUnVuRGF0YShcbiAgcnVuOiBXb3JrZmxvd1J1bixcbiAgcmVzb2x2ZURhdGE6IFJlc29sdmVEYXRhXG4pOiBXb3JrZmxvd1J1biB8IFdvcmtmbG93UnVuV2l0aG91dERhdGEge1xuICBpZiAocmVzb2x2ZURhdGEgPT09ICdub25lJykge1xuICAgIGNvbnN0IHsgaW5wdXQ6IF8sIG91dHB1dDogX18sIC4uLnJlc3QgfSA9IHJ1bjtcblxuICAgIHJldHVybiB7IGlucHV0OiB1bmRlZmluZWQsIG91dHB1dDogdW5kZWZpbmVkLCAuLi5yZXN0IH07XG4gIH1cbiAgcmV0dXJuIHJ1bjtcbn1cblxuZnVuY3Rpb24gZmlsdGVySG9va0RhdGEoaG9vazogSG9vaywgcmVzb2x2ZURhdGE6IFJlc29sdmVEYXRhKTogSG9vayB7XG4gIGlmIChyZXNvbHZlRGF0YSA9PT0gJ25vbmUnICYmICdtZXRhZGF0YScgaW4gaG9vaykge1xuICAgIGNvbnN0IHsgbWV0YWRhdGE6IF8sIC4uLnJlc3QgfSA9IGhvb2s7XG5cbiAgICByZXR1cm4geyBtZXRhZGF0YTogdW5kZWZpbmVkLCAuLi5yZXN0IH07XG4gIH1cbiAgcmV0dXJuIGhvb2s7XG59XG4iXX0=
