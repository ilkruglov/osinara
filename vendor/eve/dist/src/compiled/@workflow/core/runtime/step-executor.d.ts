import type { Event, SerializedData, StartedStep, World } from '#compiled/@workflow/world/index.js';
import type { PayloadKey } from '../serialization/encryption.js';
import { type SlotSnapshotParams } from './helpers.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';
import { type ResumeTtrTracking } from './resume-latency.js';
import { type StepLatencyTracking } from './step-latency.js';
export declare const DEFAULT_STEP_MAX_RETRIES = 3;
export interface StepExecutorParams {
    world: World;
    workflowRunId: string;
    /** Deployment that owns the workflow run, for forwarded writable streams. */
    workflowDeploymentId?: string;
    workflowName: string;
    workflowStartedAt: number;
    /** Request ID of the invocation executing this step, when provided by its queue. */
    requestId?: string;
    /** Root run id of this run's lineage, carried into the step context. */
    rootRunId?: string;
    stepId: string;
    stepName: string;
    encryptionKey?: PayloadKey;
    /**
     * The workflow run's specVersion, used to gate payload compression.
     * Step outputs/errors are only compressed when the run is marked as
     * compression-capable (specVersion >= 5).
     */
    runSpecVersion?: number;
    /**
     * Lazy step start: the already-dehydrated step input. When provided, the
     * `step_started` event carries this input so the world creates the step on
     * the fly (no separate `step_created` round-trip). Set by the owned-inline
     * path for the step whose `step_created` the suspension handler deferred.
     * The world's atomic create-claim is the exactly-one-owner gate: losing it
     * surfaces as `EntityConflictError` → `{ type: 'skipped' }`, so a handler
     * that did not win the create never runs the body. Omitted on every other
     * path, where the step already has a `step_created` and `step_started`
     * carries no payload (the legacy contract).
     */
    lazyStepInput?: SerializedData;
    /**
     * Pre-claimed inline start: the suspension handler committed (or lost) this
     * step's `step_created` + `step_started` pair inside its batched fan-out
     * write, so the start this executor would otherwise send has already been
     * decided. `owned: false` returns `{ type: 'skipped' }` before any write —
     * the same outcome as losing the lazy claim's atomic create. `owned: true`
     * skips both start paths (no start write at all) and runs the body against
     * the claimed step. Mutually exclusive with `lazyStepInput`: the input
     * already rode the pair's `step_created`, and the claimed step carries it.
     */
    preclaimedStart?: PreclaimedInlineStart;
    /**
     * Inline step ownership: the queue message ID of the invocation this
     * executeStep call runs in (from the queue handler's meta). When set, the
     * `step_started` this call sends is stamped with it — on the lazy paths
     * (where `lazyStepInput` is present) and on the owned-recovery
     * payload-less start (where it is not; the re-stamp keeps a recovered
     * step readable as owned by this message, since ownership derives from
     * the LATEST start — so a recovery start is never bare). Wake
     * replays that observe an actively-owned step suppress the immediate
     * requeue and enqueue a delayed backstop instead. Omitted on the
     * background-step path, whose bare start intentionally clears ownership
     * (the step is queue-owned from that point).
     */
    ownerMessageId?: string;
    /**
     * Inline-delta optimization (opt-in). When provided, the cursor of the
     * event log as observed by the caller *before* this step's events were
     * written. It is threaded into the step-terminal `events.create` so a
     * supporting World can return the delta of events written since (see
     * {@link import('@workflow/world').CreateEventParams.sinceCursor}).
     * Only set this when `correlationId`-based ownership guarantees this
     * handler is the sole inline writer for the run on this iteration.
     */
    inlineDeltaSinceCursor?: string;
    /**
     * How much of the run's log the caller's replay had loaded when it scheduled
     * this step, as the highest slot that log occupies. Seeds the snapshot every
     * write this executor makes carries; each committed event advances it to its
     * own slot, so a later write never names a position that predates an earlier
     * one from the same step.
     *
     * It matters most on the lazy inline path, where the `step_started` claim is
     * the step's FIRST durable write (its `step_created` is deferred): without a
     * seed the claim would name no position at all, and a replay working from a
     * stale view could claim — and then commit — a step scheduled without
     * observing an event it never loaded.
     *
     * A World that fences rejects a stale claim with `PreconditionFailedError`
     * (412); executeStep does NOT translate that rejection (re-claiming in place
     * would still commit the stale schedule), so it propagates for the caller to
     * abandon the batch and restart its replay. Undefined for a caller with
     * nothing loaded.
     */
    slotSnapshot?: SlotSnapshotParams;
    /**
     * Suppress optimistic inline start for this step regardless of
     * `WORKFLOW_OPTIMISTIC_INLINE_START` / `forceOptimisticStart`: take the
     * await-then-run path so the body only runs after the `step_started` claim
     * succeeds. Set by the runtime for guard-enforced batches that are
     * stale-sensitive (an open hook means an out-of-band event can make the
     * scheduling view stale): the guard's 412 fence can reject a stale claim's
     * durable writes, but it cannot un-run a body that optimistic start began
     * before the claim settled — awaiting the claim extends the fence to user
     * code. Wins over `forceOptimisticStart` and the env flag.
     */
    suppressOptimisticStart?: boolean;
    /**
     * Force optimistic inline start regardless of
     * `WORKFLOW_OPTIMISTIC_INLINE_START`. Set by turbo mode on the first delivery
     * of the first invocation, where forcing it is safe: there is no concurrent
     * peer handler to race the create-claim, so the body runs exactly once. Only
     * meaningful together with `lazyStepInput` (a brand-new lazy step).
     */
    forceOptimisticStart?: boolean;
    /**
     * Turbo mode only: a promise that resolves once the backgrounded
     * `run_started` has landed. When set, the lazy/optimistic `step_started` is
     * chained on it so the step is never created before its run exists. The body
     * still runs immediately against locally-synthesized state — only the network
     * write waits — so the `run_started` round-trip overlaps the body. `undefined`
     * outside turbo, where `run_started` was already awaited up front.
     */
    runReadyBarrier?: Promise<unknown>;
    /**
     * Latency telemetry (TTFS / STSO): eligibility and anchor timestamps decided
     * by the orchestrator. When set, this executor computes the final values
     * against the wall clock taken immediately before user code runs and
     * attaches them to the step's terminal event. Set only for the first step of
     * an inline batch, and only on first-attempt executions that qualify — see
     * runtime/step-latency.ts.
     */
    latencyTracking?: StepLatencyTracking;
    /**
     * Hook-resume TTR telemetry: the boundaries of a hook resumption whose next
     * durable step is the one this call is about to execute. When set, the
     * executor closes the measurement against the `step_started` claim and the
     * wall clock taken immediately before user code, and attaches the total plus
     * its phase breakdown to this step's `step.execute` span. Set by the runtime
     * for exactly one step per resumption — see runtime/resume-latency.ts.
     */
    resumeTracking?: ResumeTtrTracking;
    /**
     * Authoritative attempt number for this execution, used to bound retries
     * against `maxRetries` BEFORE the body runs. In order to also catch
     * step timeouts (which we can't have catch handlers for), we determine
     * the attempt count based as follows:
     * - Inline (combined handler): the number of `step_started` events already
     *   in the event log for this step, plus one for the attempt about to run.
     * - Background (queue-dispatched): the queue delivery count
     *   (`metadata.attempt`), which increments on every redelivery.
     */
    authoritativeAttempt?: number;
    /** One-shot recovery telemetry activated by the orchestrator replay. */
    replayRecoveryReporter?: ReplayRecoveryReporter;
}
/**
 * The settled outcome of a `step_created` + `step_started` pair the
 * suspension handler folded into its batched fan-out write (see
 * `SuspensionHandlerResult.inlineClaims`). Handed to executeStep as
 * {@link StepExecutorParams.preclaimedStart} so the executor runs (or skips)
 * the body off the batch's verdict instead of sending a start of its own.
 */
export type PreclaimedInlineStart = {
    /** The pair committed: this execution owns the step and runs the body. */
    owned: true;
    /**
     * The started step entity from the batch result, with the locally
     * dehydrated input attached by the suspension handler (batch responses
     * return refs lazily; the body's hydration wants the same bytes the
     * pair's `step_created` carried).
     */
    step: StartedStep;
    /**
     * `Date.now()` taken right before the batch POST that carried the pair
     * — the claim's "start POST sent" instant, anchoring RSFS exactly like
     * the lazy claim's own POST would.
     */
    batchPostSentAtMs?: number;
    /**
     * `Date.now()` taken right after that batch POST returned — the
     * claim's completion instant (T6 of the hook-resume TTR window).
     */
    claimCompletedAtMs?: number;
} | {
    /**
     * The pair lost its atomic create-claim (per-event 409): a concurrent
     * writer owns the step, so the body must not run here.
     */
    owned: false;
};
/**
 * Inline-delta returned by a step-terminal write when the caller passed
 * {@link StepExecutorParams.inlineDeltaSinceCursor} and the World supports
 * the optimization. `events` are the events written strictly after that
 * cursor (this step's events plus anything interleaved in-band), `cursor`
 * is the position past the last one, and `hasMore` signals a further page
 * (the caller then falls back to a full incremental fetch). Absent when
 * the World did not return a delta.
 */
export interface InlineEventDelta {
    events: Event[];
    cursor: string | null;
    hasMore: boolean;
}
/**
 * Result of a step execution attempt. The caller decides what to do
 * based on the result type (e.g., queue workflow continuation, replay inline, etc.).
 *
 * `inlineDelta` is attached to a `completed` result when the caller
 * requested it via {@link StepExecutorParams.inlineDeltaSinceCursor} and
 * the World returned one. Step failures are rare and not the inline
 * optimization's target, so the `failed` path leaves it to the normal
 * incremental fetch.
 */
export type StepExecutionResult = {
    type: 'completed';
    hasPendingOps?: boolean;
    inlineDelta?: InlineEventDelta;
} | {
    type: 'failed';
} | {
    type: 'retry';
    timeoutSeconds: number;
} | {
    type: 'skipped';
} | {
    type: 'gone';
} | {
    type: 'throttled';
    timeoutSeconds: number;
};
/**
 * Executes a single step: creates step_started event, hydrates input,
 * runs the step function, creates step_completed/step_failed/step_retrying events.
 *
 * Does NOT queue workflow continuation messages — the caller decides what to do next.
 * Used by the combined workflow handler for step execution.
 */
export declare function executeStep(params: StepExecutorParams): Promise<StepExecutionResult>;
//# sourceMappingURL=step-executor.d.ts.map