import type { CreateEventParams, CreateEventRequest, Event, EventResult, HealthCheckPayload, ValidQueueName, WorkflowRun, World } from '#compiled/@workflow/world/index.js';
import { type PayloadKey } from '../serialization/encryption.js';
/**
 * Validates a workflow name and returns the corresponding queue name.
 * Ensures the workflow name only contains safe characters before
 * interpolating it into the queue name string.
 */
export declare function getWorkflowQueueName(workflowName: string, namespace?: string): ValidQueueName;
/**
 * Result of a health check operation.
 */
export interface HealthCheckResult {
    healthy: boolean;
    /** Error message if health check failed */
    error?: string;
    /** Latency if the health check was successful */
    latencyMs?: number;
    /** Spec version of the responding deployment */
    specVersion?: number;
    /**
     * `@workflow/core` version of the responding deployment, used for
     * capability detection (see `getRunCapabilities`). Omitted when the
     * responding deployment did not provide the field as a string —
     * for example, an older `@workflow/core` that predates this field,
     * or a non-JSON plain-text health response.
     */
    workflowCoreVersion?: string;
    /**
     * The target run's X25519 public key (base64), returned only when the probe
     * carried a `runId` and the responding deployment has encryption enabled.
     *
     * Lets a cross-deployment `start()` seal the workflow arguments using a
     * response it was already waiting on, instead of making a separate
     * key-lookup request.
     */
    encryptionPublicKey?: string;
    /**
     * The responding deployment's `HOOK_RESUME_INPUT_VERSION` — the protocol
     * version at which the *consumer* (queue-message target) re-ensures the
     * `hook_received` event from `hookInput` on replay. A cross-deployment
     * `start()` stamps the *target's* value (not the caller's) into the new
     * run's `executionContext.hookResumeInputVersion` so that `resumeHook()`
     * only takes the parallel path when the deployment that will actually
     * consume the queue message is known to honor `hookInput`. Omitted when the
     * responding deployment predates this field (an older consumer that ignores
     * `hookInput`), which fails the gate closed.
     */
    hookResumeInputVersion?: number;
}
/**
 * Checks if the given message is a health check payload.
 * If so, returns the parsed payload. Otherwise returns undefined.
 */
export declare function parseHealthCheckPayload(message: unknown): HealthCheckPayload | undefined;
/**
 * Handles a health check message by writing the result to the world's stream.
 * The caller can listen to this stream to get the health check response.
 *
 * @param healthCheck - The parsed health check payload
 */
export declare function handleHealthCheckMessage(healthCheck: HealthCheckPayload, worldSpecVersion?: number): Promise<void>;
export interface HealthCheckOptions {
    /** Timeout in milliseconds to wait for health check response. Default: 30000 (30s) */
    timeout?: number;
    /** Deployment ID to send the health check to. Falls back to process.env.VERCEL_DEPLOYMENT_ID. */
    deploymentId?: string;
    /**
     * The run id the caller is about to create. When set, the responding
     * deployment derives that run's public key locally and returns it as
     * `encryptionPublicKey`, letting a cross-deployment `start()` seal the
     * workflow arguments without a separate key lookup.
     */
    runId?: string;
    /**
     * Queue namespace of the target deployment (e.g. `'eve'` for topics like
     * `__eve_wkf_workflow_*`). Falls back to `WORKFLOW_QUEUE_NAMESPACE` in the
     * calling process. Cross-context callers (e.g. the observability
     * dashboard) must pass the target deployment's namespace explicitly —
     * the env fallback resolves in the caller's process, and a message
     * published to a mismatched topic has no consumer, so the check would
     * always time out.
     */
    namespace?: string;
}
export declare function healthCheck(world: World, options?: HealthCheckOptions): Promise<HealthCheckResult>;
/**
 * Appends events whose IDs are not already present in `target`.
 *
 * Pass the IDs currently present in `target` when appending repeatedly to the
 * same array. The set is updated alongside `target`.
 *
 * Events are appended in the order the World returned them, and are not
 * re-sorted. Every append source is already in canonical order relative to the
 * tail (a cursor-delimited page, or a write-response delta), so receipt order is
 * the order to keep, and re-sorting here would only cost a pass over the log.
 * Nothing downstream may assume the tail is the newest event — see
 * {@link maxEventSlot}.
 */
export declare function appendUniqueEvents(target: Event[], events: readonly Event[], targetIds?: Set<string>): void;
/**
 * Inserts `event` into `target` at the position that keeps `target` ordered by
 * ascending `eventId`, or no-ops if an event with the same `eventId` is already
 * present (idempotent).
 *
 * `preloadedEvents` is loaded `sortOrder: 'asc'` and is never re-sorted
 * client-side, so a `hook_received` spliced in by the lazy-resume consumer must
 * land in `eventId` order — a plain `push` would place a late-committing
 * earlier event after events that sort before it, corrupting replay.
 *
 * Lexicographic string order is the log's order: a slot id is a fixed-width
 * zero-padded position, so comparing the strings compares the positions. This
 * needs no parse of its own for that reason, and the comparison is exact rather
 * than a reconstruction.
 */
export declare function insertEventByEventId(target: Event[], event: Event): void;
/**
 * Loads workflow run events by iterating through all pages of paginated
 * results. Events are returned in chronological (ascending) order for
 * deterministic workflow replay.
 *
 * @param runId - The workflow run ID.
 * @param afterCursor - If provided, only events after this cursor are
 *   returned (incremental load). If omitted, all events are returned.
 *   The returned cursor can be passed back in on a subsequent call for
 *   incremental loading.
 */
export declare function loadWorkflowRunEvents(runId: string, afterCursor?: string): Promise<LoadedEventLog>;
/**
 * The runtime's loaded event-log snapshot: the events replayed so far and the
 * cursor positioned after them. Handed to helpers that derive the precondition
 * snapshot from it; they do not mutate it.
 */
export interface LoadedEventLog {
    events: Event[];
    cursor: string | null;
}
/**
 * Whether a replay refuses to run over a log with a hole in it (see
 * {@link findEventSlotGap}). **On by default**; set
 * `WORKFLOW_SLOT_GAP_CHECK=0` to replay across holes instead.
 *
 * A World that allocates a position at the moment it commits leaves no hole
 * behind when a write fails, so density is a property the log has by
 * construction rather than one this check maintains. What the check is for is
 * the reads and the Worlds where that does not hold, and by the time it runs
 * the benign explanations are spent: a position missing because a concurrent
 * commit is not visible yet clears on a re-read, which is what
 * {@link settleEventSlotGap} does first.
 *
 * What is left is a hole that persists, and its two causes are
 * indistinguishable from the log. Either a World allocated the position outside
 * the commit and lost the write, in which case nothing happened there and
 * replaying past it is correct, or an event that did happen is missing, in
 * which case replaying past it decides a branch on absence and produces a wrong
 * result with nothing to show for it. Failing is the recoverable side of that
 * trade, and this is the way back out if a fleet turns out to carry holes of
 * the first kind.
 */
export declare function isSlotGapCheckEnabled(): boolean;
/**
 * Merge the events a bump-and-report write handed back into the log it was
 * derived from, and answer how many of them were new.
 *
 * Unlike {@link appendUniqueEvents}, this re-sorts. The reported events occupy
 * slots *below* the write that reported them, so appending them would put them
 * after events they precede. Sorting by id restores the World's canonical order
 * rather than guessing at it: a slot id is that order, written down.
 */
export declare function mergeReportedEvents(target: Event[], events: readonly Event[]): number;
/** What {@link absorbSkippedSlotReport} did with a write's report. */
export interface SkippedSlotReport {
    /** How many of the reported events were new to the log. Zero if dropped. */
    added: number;
    /** How many events the report offered, whether or not they were taken. */
    offered: number;
    /** The report was truncated, so it was dropped whole instead of merged. */
    truncated: boolean;
}
/**
 * Apply a write's skipped-slot report to the log it was derived from, deciding
 * whether the report may be taken at all.
 *
 * Every replay-context write can come back carrying the events on the slots it
 * skipped over, and every caller wants the same thing from them: fold them in
 * so the writes that follow name a position above them, and so the replay
 * resuming from this log sees them without a reload.
 *
 * The one policy is that a **truncated report is dropped whole**. It covers a
 * span of positions but carries only some of the events on them, so merging it
 * would raise the log's highest position past a position whose event is
 * missing. Later writes read that maximum to say what they have seen, so each
 * would claim a position it never saw, and the World only reports the span a
 * write skips — it would never send the missing one. Dropping costs one more
 * round of the same events on the next write and keeps the log a prefix of the
 * truth, which the note above {@link mergeReportedEvents} explains is always an
 * available answer.
 *
 * Callers that log do so from the returned counts; the decision is not theirs
 * to re-derive.
 */
export declare function absorbSkippedSlotReport(target: Event[], result: {
    events?: readonly Event[];
    hasMore?: boolean;
}): SkippedSlotReport;
/**
 * The highest slot the loaded log occupies, or `undefined` for an empty log.
 *
 * The maximum, not the count, and the two are not interchangeable even though
 * a healthy log makes them equal. A World hands a position to the insert that
 * occupies it, so a write that never lands leaves no hole behind and the log
 * stays dense. What the count cannot survive is a *partial* read: a log
 * assembled from a truncated report, or read while a concurrent write is
 * committing, holds fewer events than its highest position. Counting those
 * would make the next write claim to have seen less than it has, so the World
 * would report the same events back to it on every attempt.
 *
 * A hole below the maximum is therefore a property of the read, not of the log,
 * which is what lets {@link settleEventSlotGap} re-read instead of giving up.
 *
 * @throws if any event id carries no slot. Every World the runtime replays
 * against numbers events by slot, so an id that does not is a broken log rather
 * than an older one, and a maximum derived by skipping it would understate the
 * log to every write that reads it.
 */
export declare function maxEventSlot(events: readonly Event[]): number | undefined;
/** A position the log skips over, described well enough to name in an error. */
export interface EventSlotGap {
    /** The lowest slot below the log's maximum that no event occupies. */
    firstMissingSlot: number;
    /** How many slots below the maximum no event occupies. */
    missingCount: number;
    /** The highest slot the log occupies. */
    maxSlot: number;
}
/**
 * The hole in a loaded log, or `undefined` when there is none to find.
 *
 * The World allocates every position, so a log that holds `n` events below slot
 * `n` is missing one. That matters before a replay
 * and nowhere else: the replay reads the log as the complete record of what has
 * happened, and an absent position is indistinguishable from an event that
 * never occurred. The branch it would have decided gets decided the other way,
 * and the run diverges quietly rather than failing.
 *
 * Order-independent, unlike the equivalent audit the World runs over a page it
 * just read. A loaded log is assembled from listed pages plus whatever a
 * bump-and-report write handed back, and while {@link mergeReportedEvents}
 * restores id order, a check that can fail a healthy run should not depend on
 * that having happened.
 *
 * The first slot is never counted. It belongs to `run_created`, which `start()`
 * posts concurrently with the queue send, so a log read in that window
 * legitimately begins at the second slot and fills in on its own. Every replay
 * that races a run's own start would otherwise report a hole.
 *
 * Returns `undefined` for an empty log, which has no density to check.
 *
 * @throws if any event id carries no slot, for the reason {@link maxEventSlot}
 * gives.
 */
export declare function findEventSlotGap(events: readonly Event[]): EventSlotGap | undefined;
/**
 * How many times a detected hole is re-read before the log is taken at its
 * word, and the backoff before each re-read (doubling per attempt).
 *
 * A hole can be transient. The World allocates a slot inside the insert that
 * occupies it, so two concurrent writers can collide, one retry past the other,
 * and the higher slot commit first — leaving a window in which the lower one is
 * genuinely absent from a strongly-consistent read and fills in a moment later.
 * The window is one commit wide, so a short backoff clears it; anything that
 * survives all three re-reads is a position no write will ever occupy.
 */
export declare const SLOT_GAP_RECHECK_ATTEMPTS = 3;
/**
 * Re-read a log that looks holey until the hole fills in or the re-reads run
 * out, and return the settled log alongside the hole that survived.
 *
 * Reads are strongly consistent, so a hole is not an artifact of *when* the log
 * was read — but it can be an artifact of a write that had not committed yet
 * (see {@link SLOT_GAP_RECHECK_ATTEMPTS}). Distinguishing the two costs a
 * re-read, which is only ever paid by a replay that already found a hole.
 *
 * The reload is full rather than incremental: the missing position is below the
 * log's maximum, so a cursor-anchored read starts past it and can never see it
 * arrive.
 */
export declare function settleEventSlotGap(runId: string, loaded: LoadedEventLog): Promise<{
    log: LoadedEventLog;
    gap: EventSlotGap | undefined;
}>;
/**
 * How much of its run's log a replay-context event creation had loaded when it
 * decided to write, as the highest slot that log occupies.
 *
 * One integer says it because the World keeps its positions dense: a writer
 * that names slot N is claiming to hold every event from 1 to N and nothing
 * above. The World answers by numbering the write above whatever the log has
 * actually reached and handing back the events on the slots in between — the
 * ones this writer decided without.
 *
 * Density is the World's invariant, not a claim about this particular read. A
 * reader that is short of a position it holds no event for names a lower N,
 * which understates what it has seen and only costs it a wider report. Naming
 * a position it cannot account for is the direction that is unsafe, which is
 * why {@link slotSnapshotParams} takes the maximum rather than the count.
 *
 * Its own object rather than a bare number so a call site cannot half-send it,
 * and so the empty case spreads to nothing.
 */
export interface SlotSnapshotParams {
    eventCount?: number;
}
/**
 * Build the slot snapshot to attach to a replay-context event creation.
 *
 * Empty for an empty log, which is the state a `run_created` write is issued
 * from: there is no position held yet to name.
 *
 * The maximum rather than the length, for the reason {@link maxEventSlot}
 * gives: a partially-read log holds fewer events than its highest position, and
 * counting those would make the write claim to have seen less than it has, so
 * the World would report the same events back on every attempt.
 */
export declare function slotSnapshotParams(events: readonly Event[]): SlotSnapshotParams;
/**
 * The events a rejecting World attached to a `PreconditionFailedError`, when it
 * returned the ones the client's snapshot was missing inline.
 *
 * Returns `null` for anything else — no details, a World that did not implement
 * this, or a payload that does not narrow cleanly. Callers fall back to
 * reloading the event log, which is always correct; this is untrusted-shaped
 * data on a failure path, so nothing here is repaired.
 *
 * `runId` is the caller's run. Every event must belong to it: the delta is
 * merged straight into the replay's log, and one foreign event there is a
 * corrupt log rather than a corrected one — the replay would consume a
 * correlation id for an event that does not exist on this run.
 */
export declare function preconditionEventDelta(error: unknown, runId: string): {
    events: Event[];
    cursor: string | null;
} | null;
/** Creates one event on a bound run, carrying replay-recovery telemetry. */
export type EventCreator = (data: CreateEventRequest, params?: CreateEventParams) => Promise<EventResult>;
/**
 * Wraps a request/response handler and adds a health check "mode"
 * based on the presence of a `__health` query parameter.
 */
export declare function withHealthCheck(handler: (req: Request) => Promise<Response>, worldSpecVersion?: number): (req: Request) => Promise<Response>;
/**
 * Idempotency key for a step's background-dispatch queue message, scoped to
 * the step's IDENTITY — correlation id plus (hashed) step name — rather than
 * the bare correlation id.
 *
 * The scoping matters for resilient step dispatch under the precondition
 * guard: a guard-rejected `step_created` leaves its (revoked) step message in
 * flight, and the corrected replay may re-derive the same correlation id for
 * a DIFFERENT step. Under a bare-correlationId key the corrected replay's
 * dispatch would silently dedupe against the revoked in-flight message —
 * which then resolves `skipped` against the re-created entity (the server's
 * stepName fence rejects its bare start) — and the legitimate step would
 * never be executed. Scoping by step name keeps every dedup property that
 * matters (crash recovery re-dispatch, concurrent handlers, the delayed
 * retry sharing the suspension re-dispatch's key — all name the same step)
 * while letting the corrected schedule's dispatch through.
 *
 * Every producer of a step-dispatch (or step-retry) message must use this
 * key. Cross-version mixing is not a concern: queue messages are pinned to
 * the deployment that produced them, so one run never sees two key schemes.
 */
export declare function stepDispatchIdempotencyKey(correlationId: string, stepName: string): string;
/**
 * Queues a message to the specified queue with tracing.
 */
export declare function queueMessage(world: World, ...args: Parameters<typeof world.queue>): Promise<void>;
/**
 * Calculates the queue overhead time in milliseconds for a given message.
 */
export declare function getQueueOverhead(message: {
    requestedAt?: Date;
}): {
    [k: string]: number;
} | undefined;
/**
 * Returns a memoized accessor for a run's full encryption capability.
 *
 * The first call resolves the run's key material via
 * `world.getEncryptionKeyForRun` (which may do HKDF derivation locally on
 * Vercel, or a network fetch from external contexts) and derives a
 * {@link PayloadKey} from it; subsequent calls await the same cached promise.
 * If the world doesn't support encryption or the run has no key configured,
 * the cached value is `undefined`.
 *
 * The resolved value is deliberately the *full* capability — the symmetric AES
 * key plus the run's X25519 keypair — not just a `CryptoKey`. A run reading
 * its own event log can encounter sealed (`encp`) payloads that another run
 * wrote to it (a cross-deployment hook resumption, say), and opening those
 * needs the keypair. Resolving only the symmetric key would leave those
 * payloads unopenable and wedge the run.
 *
 * Used by step / workflow handlers to defer the (potentially expensive)
 * key fetch until the first code path that actually needs it — typically
 * input hydration on the success path, or error dehydration on a failure
 * path. Both paths can race-call the accessor without triggering duplicate
 * fetches.
 *
 * Errors thrown by `getEncryptionKeyForRun` propagate to every caller
 * (the cached promise rejects). This is intentional: when encryption is
 * configured, we never want to silently fall back to plaintext
 * serialization. A propagated error in an event-emission path leaves the
 * outer try/catch to log and surface the issue; the queue's redelivery
 * semantics will retry the key fetch on the next attempt.
 */
export declare function memoizeEncryptionKey(world: World, runOrId: WorkflowRun | string): () => Promise<PayloadKey | undefined>;
//# sourceMappingURL=helpers.d.ts.map