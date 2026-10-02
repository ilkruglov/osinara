import type { Span } from '#compiled/@opentelemetry/api/index.js';
import { type SerializedData, type TraceCarrier, type ValidQueueName, type WorkflowRun, type World } from '#compiled/@workflow/world/index.js';
import type { StepInvocationQueueItem, WorkflowSuspension } from '../global.js';
import { type LoadedEventLog } from './helpers.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';
import type { PreclaimedInlineStart } from './step-executor.js';
export interface SuspensionHandlerParams {
    suspension: WorkflowSuspension;
    world: World;
    run: WorkflowRun;
    span?: Span;
    requestId?: string;
    /**
     * The runtime's loaded event log. Every event creation this suspension makes
     * names the position it was derived from, so a backend that has recorded
     * events the replay did not see can report them back on the write — or, if
     * it would rather refuse than report, reject it with a 412. A rejection is
     * not retried here: the event's correlation id was minted by *this* replay's
     * seeded sequence, so re-committing it against a corrected log would persist
     * an event no correct replay produces. The caller restarts the replay
     * instead.
     */
    eventLog?: LoadedEventLog;
    /**
     * Turbo mode only: a promise that resolves once the backgrounded
     * `run_started` has landed (the run exists). When present, every world write
     * this suspension performs (`hook_created`, `wait_created`, eager overflow
     * `step_created`, …) is gated on it so the write never races ahead of the
     * run's creation. The pure inline hot path defers all of its steps and writes
     * nothing here, so it never awaits this barrier. `undefined` outside turbo,
     * where `run_started` was already awaited up front.
     */
    runReadyBarrier?: Promise<unknown>;
    /** One-shot telemetry reporter, activated only after replay has recovered. */
    replayRecoveryReporter?: ReplayRecoveryReporter;
    /**
     * Resilient step dispatch: when provided (and the per-step eligibility gates
     * pass — see the step ops below), each newly created non-inline step's
     * `step_created` write is parallelized with its step-execution queue
     * publish, and the queue message carries the serialized step input
     * (`stepInput`) so the consumer can idempotently re-ensure the event if the
     * direct write failed transiently. Steps queued this way are reported in
     * {@link SuspensionHandlerResult.queuedStepCorrelationIds} so the caller
     * skips them in its own dispatch pass. Omitted by callers that must not
     * queue (terminal drain, tests) — creates then behave exactly as before.
     */
    stepDispatch?: {
        /** The unified workflow queue this run's step messages are published to. */
        queueName: ValidQueueName;
        /**
         * Lazily resolves the trace carrier to stamp on the step messages.
         * Called at most once per suspension (memoized here).
         */
        getTraceCarrier: () => Promise<TraceCarrier>;
    };
    /**
     * Inline step ownership: the queue message ID of the invocation this
     * suspension runs in (the queue handler's meta). When present AND the
     * batched fan-out engages, the lazy-inline steps' deferred writes are
     * folded into the batch as `step_created` + `step_started` pairs — the
     * started row stamped with this ID, exactly like the lazy claim it
     * replaces — pre-claiming the steps the caller is about to run inline. See
     * {@link SuspensionHandlerResult.inlineClaims}. Callers that never
     * inline-execute (terminal drain) omit it, keeping their lazy steps on the
     * plain deferred path.
     */
    ownerMessageId?: string;
    /**
     * Lets the batched fan-out return before every chunk has committed: only
     * the chunk carrying the pre-claimed inline pairs gates the handler's
     * return (its claims are what the caller starts bodies from), while the
     * trailing chunks' commits — and every chunk's in-flush step-message
     * publishes — ride {@link SuspensionHandlerResult.deferredBatchWork}. A
     * caller that opts in MUST await that promise before acking its delivery:
     * the durability contract ("every create durable before ack") moves from
     * the handler's return to that join, and nothing else re-drives a lost
     * trailing chunk. Callers that don't opt in (terminal drain, default)
     * keep the everything-durable-at-return behavior.
     */
    allowDeferredBatchWork?: boolean;
}
/**
 * Result of handling a suspension. Returns pending step items so the caller
 * can decide which to execute inline vs queue to background.
 */
export interface SuspensionHandlerResult {
    /** Pending step items with events created but NOT queued */
    pendingSteps: StepInvocationQueueItem[];
    /**
     * Correlation IDs for which this suspension call actually wrote the
     * step_created event (as opposed to catching EntityConflictError because
     * a concurrent handler wrote it first). Only the handler that wrote the
     * step_created event should queue / inline-execute the step — this
     * guarantees a single owner per step, even when multiple handlers race
     * into the same batch boundary.
     */
    createdStepCorrelationIds: Set<string>;
    /**
     * Correlation IDs of steps this suspension call already published
     * step-execution queue messages for, via resilient step dispatch (the
     * `step_created` write parallelized with a `stepInput`-carrying queue
     * publish). The caller MUST NOT dispatch these again — the message is
     * already out (a duplicate would be deduped by its idempotency key, but
     * costs a wasted round-trip). Empty when {@link SuspensionHandlerParams.stepDispatch}
     * was not provided or no step was eligible.
     */
    queuedStepCorrelationIds: Set<string>;
    /**
     * How many events this phase's writes reported back as occupying slots they
     * skipped over, already merged into the caller's `eventLog.events`. Nonzero
     * means the array was reordered to restore slot order, so any index the
     * caller cached into it (payload prewarm scan position) is stale.
     */
    reportedEventCount: number;
    /**
     * The steps whose `step_created` writes were intentionally deferred so the
     * caller can run them inline via lazy `step_started` events (which create
     * the step on the fly), saving one world round-trip per inline step. Up to
     * `getMaxInlineSteps()` steps are deferred; the caller runs them inline in
     * parallel and queues the rest. Empty when no step was deferred (nothing
     * pending, or a `hook.getConflict()` awaiter is present so nothing is
     * executed inline). The caller passes each `dehydratedInput` straight to
     * `executeStep`, which sends it as the `step_started` payload. The atomic
     * create-claim inside each `step_started` is the exactly-one-owner gate that
     * the standalone `step_created` provided before: the loser of the race gets
     * `EntityConflictError` → `skipped` and does not run the body.
     */
    lazyInlineSteps: Array<{
        correlationId: string;
        stepName: string;
        dehydratedInput: SerializedData;
    }>;
    /**
     * Pre-claimed inline starts, by correlation id: the per-step verdicts of
     * the `step_created` + `step_started` pairs the batched fan-out committed
     * for the lazy-inline steps. A step with an entry here is passed to
     * `executeStep` as `preclaimedStart` INSTEAD of `lazyStepInput` — its
     * input already rode the pair, and the claim is settled: `owned: true`
     * carries the started attempt-1 entity (input re-attached) so the body
     * runs straight off the batch commit with no start write of its own;
     * `owned: false` lost the pair's atomic create-claim to a concurrent
     * writer, and executeStep returns `skipped` without running the body —
     * the same outcome as losing the lazy claim. Empty whenever the fold did
     * not engage (batching off, no `ownerMessageId`, or the lone-inline case,
     * which keeps the optimistic lazy path and its claim/body overlap).
     *
     * Crash window: the pair commits before the caller runs the body, so a
     * crash between them leaves a started step stamped with this message's
     * ID. Redelivery of the same message re-executes it via the owned-recovery
     * path — the exact machinery the lazy claim's crash window already uses.
     */
    inlineClaims: Map<string, PreclaimedInlineStart>;
    /**
     * The highest slot the batched fan-out committed, when it ran. The batch's
     * own events are not in the caller's loaded log (the next reload picks
     * them up), so the caller folds this ceiling into the slot snapshot it
     * hands the inline executions — otherwise every inline terminal write
     * would name a pre-batch position and be answered with a skipped-slot
     * report echoing the events this suspension just wrote. Under
     * {@link SuspensionHandlerParams.allowDeferredBatchWork} this covers the
     * chunks that had committed by the handler's return (always the pair
     * chunk); a trailing chunk that commits later is echoed back on the
     * terminal writes like any foreign event — reports the executor reads for
     * position and discards.
     *
     * So the echo is only fully suppressed for a SINGLE-chunk fold. On a
     * multi-chunk fan-out the bodies start off the pair chunk while trailing
     * chunks are still in flight, and an inline terminal write issued in that
     * window still names a position below them and still draws a report for
     * their events. Bounded (trailing chunks only, large fan-outs only) and
     * self-correcting on the next reload — recorded so a report seen there
     * reads as expected rather than as a bug.
     */
    batchCommittedSlotCeiling?: number;
    /**
     * The batched fan-out's deferred work, present only when the caller opted
     * in via {@link SuspensionHandlerParams.allowDeferredBatchWork} and
     * trailing work exists: the commits of every chunk except the pair chunk,
     * plus every chunk's step-message publishes (each chained on ITS OWN
     * chunk's commit, so publish-after-create holds per step). The caller
     * MUST await it before acking — a rejection here is a failed suspension
     * write and fails the delivery exactly as it would have at the handler's
     * return. Steps whose messages this work publishes are already in
     * {@link queuedStepCorrelationIds} at return time.
     */
    deferredBatchWork?: Promise<void>;
    /**
     * The soonest pending wait, if any: seconds until it elapses and the
     * correlationId of the wait that produced that timeout. The
     * correlationId seeds the idempotency key for the wait-continuation
     * queue message so that repeated suspension passes over the same
     * pending wait collapse into a single delayed continuation.
     */
    waitTimeout?: {
        seconds: number;
        correlationId: string;
    };
    /** Whether a hook conflict was detected (should re-invoke immediately) */
    hasHookConflict: boolean;
    /** Whether a `hook.getConflict()` awaiter needs the workflow to continue immediately */
    hasAwaitedHookCreation: boolean;
    /** Whether native workflow attribute events were written for replay. */
    hasAttributeEvents: boolean;
    /**
     * Whether this suspension created any hook (`hook_created`) events. Unlike
     * `hasHookConflict` / `hasAwaitedHookCreation`, this is true even for a plain
     * fire-and-forget hook with no conflict and no awaiter. Turbo mode uses it to
     * detect "a hook was created this suspension" and stop forcing optimistic
     * inline start (a hook introduces later resume invocations that could race).
     */
    hasHookEvents: boolean;
    /**
     * Wall-clock ms spent committing this suspension's `hook_created` events
     * (0 when it created none). The caller accumulates this across iterations
     * and subtracts it from the TTFS latency measurement, so time spent
     * durably creating the user's hooks doesn't count as runtime overhead.
     */
    hookCreationMs: number;
    /**
     * Whether serializing this suspension's new step inputs was passive (did
     * not execute workflow-owned code such as getters, proxy traps, or custom
     * serializers). `false` means the retained VM may have diverged from what
     * a cold replay would compute, so the caller must demote to replay.
     */
    retainedStepInputsSafe: boolean;
}
/**
 * Handles a workflow suspension by processing all pending operations (hooks, steps, waits).
 * Creates events for all operations but does NOT queue step messages — returns the pending
 * steps so the caller can decide which to execute inline vs queue to background.
 *
 * Processing order:
 * 1. Hooks are processed first to prevent race conditions with webhook receivers
 * 2. Step events and wait events are created in parallel
 */
export declare function handleSuspension({ suspension, world, run, span, requestId, eventLog, runReadyBarrier, replayRecoveryReporter, stepDispatch, ownerMessageId, allowDeferredBatchWork, }: SuspensionHandlerParams): Promise<SuspensionHandlerResult>;
//# sourceMappingURL=suspension-handler.d.ts.map