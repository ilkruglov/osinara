import type { HookResumeTiming } from '#compiled/@workflow/world/index.js';
/**
 * Hook-triggered time-to-resume (TTR): wall-clock from entry into
 * `resumeHook()` (T0) to the first line of the next durable step (T7), plus a
 * decomposition into non-overlapping phases that sum exactly to it.
 *
 * ```text
 * T0 resumeHook() entered
 *      producer_prep   — hook lookup, serialization, encryption
 * T1 queue publish requested
 *      queue_delivery  — network + VQS delivery (incl. any affinity re-route)
 * T2 final consumer's queue handler entered
 *      resume_setup    — affinity check, hook_received re-ensure, replay preload
 * T3 replay begins
 *      replay          — VM/session creation and workflow replay
 * T4 next durable step encountered
 *      step_dispatch   — suspension handling, inline batch or queue dispatch
 * T5 step_started request begins
 *      step_claim      — the claim round trip
 * T6 step_started response returned
 *      step_prepare    — key resolution, argument hydration, context setup
 * T7 immediately before stepFn.apply()
 * ```
 *
 * The producer's direct `hook_received` POST races the queue publish on the
 * parallel fast path, so it deliberately has no phase of its own — the two
 * overlap, and representing both as additive phases would double-count. It
 * remains visible as a contextual span (`hook.resume`).
 *
 * T0/T1 are stamped on the producer's machine and T2..T7 on the consumer's, so
 * the measurement is subject to cross-machine clock skew. Rather than clamp
 * (which would break the sum-equals-total property this decomposition exists
 * for), a non-monotonic boundary set drops the whole sample — see
 * {@link computeResumeTtrAttributes}.
 */
/** What caused the resumption being measured. Only hooks are measured today. */
export type ResumeTrigger = 'hook';
/** Which `resumeHook()` dispatch path produced this resume. */
export type ResumeStrategy = 'parallel' | 'sequential';
/**
 * How the consuming invocation initialized its replay state:
 *
 * - `hook_preload` — the hoisted `hook_received` write returned a usable
 *   replay preload, so neither `run_started` nor the initial `events.list` ran.
 * - `run_started` — the generic `run_started` setup ran (including the fast
 *   path's fallback, where the hoisted write succeeded but returned no usable
 *   preload).
 * - `event_load` — neither setup ran because the run arrived already loaded,
 *   so setup was a plain event load. No current path produces it (the one
 *   preloaded-run path, the background-step fall-through, consumes the
 *   tracking on its own step first); it is the honest default rather than a
 *   live value, and keeps the dimension total if such a path is added.
 */
export type ResumeSetupSource = 'hook_preload' | 'run_started' | 'event_load';
/** Whether the measured step ran in the resuming invocation or a queued one. */
export type ResumeStepExecution = 'inline' | 'dispatched';
/**
 * The resume boundaries observed so far, threaded from the queue handler into
 * `executeStep`. Producer fields arrive on the queue message
 * ({@link HookResumeTiming}); consumer fields are stamped by the invocation
 * that replays the resume.
 *
 * The runtime holds at most one of these per invocation and CONSUMES it when
 * it hands it to the execution that will attempt the next durable step, so a
 * later step in the same invocation — or a retry of the same step — never
 * re-reports the same resumption. Within one inline batch the object is
 * shared by every step and the {@link ResumeTtrTracking.reported} latch picks
 * the single reporter.
 */
export interface ResumeTtrTracking {
    trigger: ResumeTrigger;
    /** Absent only if an older producer omitted it from the queue message. */
    strategy?: ResumeStrategy;
    /** T0 — entry into `resumeHook()`. */
    resumeRequestedAtMs: number;
    /** T1 — immediately before the queue publish was requested. */
    queuePublishRequestedAtMs: number;
    /**
     * T2 — entry into the FINAL consumer's queue handler. A delivery that
     * re-routes for deployment affinity never stamps this, so the re-routed hop
     * stays inside `queue_delivery` where it belongs.
     */
    consumerStartedAtMs: number;
    /** T3 — this invocation's first replay pass. */
    replayStartedAtMs?: number;
    /** T4 — replay first encountered a durable step after the resume. */
    nextStepEncounteredAtMs?: number;
    setupSource?: ResumeSetupSource;
    stepExecution: ResumeStepExecution;
    /**
     * One-shot latch, set by the step executor once this resumption has been
     * reported. Every step of an inline batch is handed the SAME tracking
     * object, so the first one to reach user code takes the measurement and the
     * rest see this and skip — one resumption, one sample, without pinning the
     * sample to a step that may lose its create-claim and never run.
     *
     * Deliberately not part of {@link HookResumeTiming}: it is invocation-local
     * state, and a queue message carries the boundaries, not the claim.
     */
    reported?: boolean;
}
/**
 * Rebuild tracking from a queue message's timing object. Returns undefined for
 * a message that carries none (an older producer, or any non-hook delivery) —
 * the caller then simply reports no TTR.
 */
export declare function resumeTrackingFromMessage(timing: HookResumeTiming | undefined, stepExecution: ResumeStepExecution): ResumeTtrTracking | undefined;
/**
 * Serialize tracking back onto a queue message, for the case where the
 * resuming invocation dispatches the next durable step to another invocation
 * instead of running it inline. Returns undefined when the tracking is not
 * complete enough to be worth forwarding.
 */
export declare function resumeTimingForMessage(tracking: ResumeTtrTracking | undefined): HookResumeTiming | undefined;
/**
 * Compute the TTR span attributes for a step that is the first durable step
 * following a hook resume. Returns undefined — emitting nothing at all — when
 * any of these hold:
 *
 * - the invocation carries no resume tracking (not a hook resume, or an older
 *   queue message with no timing);
 * - this is a retry (`attempt !== 1`), which measures a re-execution rather
 *   than the resumption;
 * - a required boundary is missing, non-finite, or out of order.
 *
 * `step_claim_ms` is the one phase that may be individually omitted. Under
 * optimistic inline start the `step_started` claim is deliberately NOT awaited
 * before the body runs, so its completion instant does not exist yet at T7;
 * rather than invent one, the claim phase is dropped and `step_prepare_ms`
 * spans T5→T7. The sum-equals-total property holds either way.
 */
export declare function computeResumeTtrAttributes(params: {
    tracking: ResumeTtrTracking | undefined;
    /** The attempt number of the execution about to run. */
    attempt: number;
    /** T5 — `Date.now()` immediately before the `step_started` request. */
    stepClaimStartedAtMs: number | undefined;
    /** T6 — `Date.now()` once the `step_started` response returned. */
    stepClaimCompletedAtMs: number | undefined;
    /** T7 — `Date.now()` immediately before `stepFn.apply()`. */
    stepCodeStartedAtMs: number;
}): Record<string, string | number> | undefined;
//# sourceMappingURL=resume-latency.d.ts.map