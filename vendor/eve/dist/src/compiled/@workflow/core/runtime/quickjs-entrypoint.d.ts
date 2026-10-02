/**
 * QuickJS VM integration with the Workflow DevKit.
 *
 * This module provides the entry point for running workflows in the
 * QuickJS WASM VM engine instead of the `node:vm` engine. Both engines
 * implement the same event-replay execution model — every invocation:
 *
 * 1. Loads the full event log for the run
 * 2. Runs the workflow function from the top in a fresh QuickJS VM,
 *    replaying the event log to resolve awaited primitives
 * 3. On suspension: creates events + queues steps for new pending ops
 * 4. On completion: creates run_completed
 * 5. On failure: creates run_failed
 */
import type { Span } from '#compiled/@opentelemetry/api/index.js';
import { type Event, type RunInput, type WorkflowRun } from '#compiled/@workflow/world/index.js';
/**
 * Returns true when the supplied preloaded events indicate this is the
 * first workflow handler invocation for the run — i.e. the log contains
 * nothing beyond `run_created` / `run_started`. In that case the
 * preloaded events ARE the complete event log and the `events.list`
 * round-trips can be skipped entirely.
 *
 * Crucially, if the world backfilled a missing `run_created` via the
 * resilient start path, `preloadedEvents` contains it even when a fresh
 * `events.list` might not (eventual consistency), so preferring the
 * preloaded events on first invocation is also the more correct choice.
 *
 * Returns false when `preloadedEvents` is missing/empty so the caller
 * falls back to the normal fetch path.
 *
 * Exported for unit testing.
 */
export declare function isFirstInvocation(preloadedEvents: readonly Event[] | undefined): boolean;
/**
 * Run a workflow using the QuickJS WASM VM engine.
 *
 * This replaces the `node:vm` replay path (runWorkflow + EventsConsumer)
 * with a QuickJS VM invocation that performs the same full event replay.
 *
 * KNOWN GAP — slot snapshot: unlike the node:vm path, no event write in
 * this file carries {@link CreateEventParams.eventCount}, so a World never
 * learns which events the writer had not seen and never reports them back.
 * The engine currently relies on per-(runId, correlationId) event
 * uniqueness (EntityConflictError dedup) alone. This is a deliberate
 * simplification while the engine is experimental — wiring the snapshot is
 * tracked follow-up work; anyone adding new write paths here should not
 * assume parity with the node engine on this axis.
 */
export declare function runWorkflowWithQuickJS(params: {
    workflowCode: string;
    workflowName: string;
    workflowRun: WorkflowRun;
    /**
     * Events returned inline by `events.create('run_started', ...)` or by
     * the lazy hook fast path's `hook_received` preload. When they indicate
     * a first invocation — or when `preloadedEventsComplete` attests they
     * are the complete log — they are used as the event log instead of
     * fetching via `events.list`, matching the node:vm engine's fast path.
     */
    preloadedEvents?: Event[];
    /**
     * True when the caller has validated that `preloadedEvents` is the run's
     * COMPLETE event log (e.g. the lazy hook fast path's hasMore-false
     * replay preload). The first-invocation heuristic below only recognizes
     * run_created/run_started-only preloads, so without this attestation a
     * hook-resume preload would be discarded and refetched.
     */
    preloadedEventsComplete?: boolean;
    /**
     * Run input carried through the queue message on first delivery. Used
     * as a last-resort fallback for `run_created.eventData.input` when
     * the event log is incomplete.
     */
    runInput?: RunInput;
    /**
     * The parent OTel span (the outer `WORKFLOW {workflowName}` span from
     * `runtime.ts`). When supplied, VM lifecycle attributes are attached
     * to it for end-to-end visibility.
     */
    parentSpan?: Span;
    /**
     * Server-supplied per-run event ceiling from the run_started response
     * (undefined ⇒ no enforcement). Mirrors the node:vm engine's guard:
     * a runaway run is failed once its log reaches the ceiling. The throw
     * propagates to the replay loop's catch in runtime.ts (the QuickJS
     * dispatch runs inside that loop's try), which classifies it and
     * records run_failed with MAX_EVENTS_EXCEEDED.
     */
    maxEventsLimit?: number;
    /**
     * Queue delivery attempt of the message driving this invocation (from
     * the queue handler's metadata; 1 = first delivery). Surfaced in
     * diagnostics; crash recovery itself is driven by the ownership-lease
     * decision table in the loop, not by the attempt count.
     */
    deliveryAttempt?: number;
    /**
     * Queue message ID of the delivery driving this invocation, stamped as
     * `ownerMessageId` on inline lazy step claims so wake replays defer to
     * the in-flight body instead of requeueing the step.
     */
    ownerMessageId?: string;
    /** Request ID of the queue invocation, when the queue provides one. */
    requestId?: string;
    /**
     * Queue namespace resolved at route registration (runtime.ts). Must be
     * threaded into every message publish: the builders bake the namespace
     * into generated routes, so consumers listen on `__<ns>_wkf_workflow_*`
     * — a publish without it lands on `__wkf_workflow_*` and is never
     * picked up.
     */
    namespace?: string;
    /**
     * Run-origin trace carrier accessor from runtime.ts
     * (getNextTraceCarrier). In the default `linked` trace mode every
     * invocation must link back to the run's origin (workflow.start) in a
     * star; capturing the current invocation context instead would chain
     * invocations to each other and fragment the run view on async queues.
     */
    nextTraceCarrier?: () => Promise<Record<string, string>>;
}): Promise<{
    timeoutSeconds?: number;
} | void>;
//# sourceMappingURL=quickjs-entrypoint.d.ts.map