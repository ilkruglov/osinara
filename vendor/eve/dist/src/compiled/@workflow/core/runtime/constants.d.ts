export declare const MAX_QUEUE_DELIVERIES = 48;
/**
 * Effective max queue deliveries. Override via `WORKFLOW_MAX_QUEUE_DELIVERIES`.
 */
export declare function getMaxQueueDeliveries(): number;
/**
 * Default maximum time allowed for the *replay* portion of a single workflow
 * handler invocation (in ms). This budget only covers deterministic-replay
 * and workflow-VM execution between step boundaries — inline step bodies
 * (`"use step"` functions invoked via `executeStep`) do NOT count against
 * it. Step bodies are bounded separately by the platform's function
 * `maxDuration` (e.g. 800s on Vercel Pro Fluid) and `NO_INLINE_REPLAY_AFTER_MS`.
 *
 * If the non-step ("replay") time within a single invocation exceeds this
 * budget, the handler rejects so the queue can retry. After
 * `REPLAY_TIMEOUT_MAX_RETRIES` exhausted attempts the run is failed with
 * `RUN_ERROR_CODES.REPLAY_TIMEOUT`.
 *
 * Note that on Vercel Hobby (standard functions), the platform `maxDuration`
 * is 60s — well below this budget, so the platform SIGTERM will fire first
 * and the queue will re-deliver until the visibility window expires. With
 * Fluid Compute on Hobby the per-function ceiling rises to 300s, still
 * under the default budget.
 *
 * Override via the `WORKFLOW_REPLAY_TIMEOUT_MS` env var (clamped to
 * `MIN_REPLAY_TIMEOUT_MS`..`MAX_REPLAY_TIMEOUT_MS`).
 */
export declare const REPLAY_TIMEOUT_MS = 240000;
/** Lower bound for the replay-timeout env var override. */
export declare const MIN_REPLAY_TIMEOUT_MS = 30000;
/**
 * Upper bound for the replay-timeout env var override. 780s leaves ≥20s of
 * headroom under Vercel Pro Fluid's 800s function ceiling so the handler
 * can write `run_failed` before SIGTERM.
 */
export declare const MAX_REPLAY_TIMEOUT_MS = 780000;
/**
 * Resolve the effective replay-timeout budget for the current process.
 *
 * Reads `process.env.WORKFLOW_REPLAY_TIMEOUT_MS` lazily so tests and
 * deployments can override per invocation. Invalid / out-of-range values
 * fall back to a safe value (no throw — the env var is an escape hatch,
 * not a hard requirement) and emit a one-time warning so misconfiguration
 * is observable.
 */
export declare function getReplayTimeoutMs(): number;
/**
 * Reset the warn-once cache. Test-only — exported so unit tests can
 * exercise the warn path repeatedly without sharing state.
 *
 * @internal
 */
export declare function _resetReplayTimeoutWarnCacheForTests(): void;
export declare const REPLAY_TIMEOUT_MAX_RETRIES = 3;
/**
 * Effective replay-timeout retry budget. Override via
 * `WORKFLOW_REPLAY_TIMEOUT_MAX_RETRIES`.
 */
export declare function getReplayTimeoutMaxRetries(): number;
/**
 * Default maximum number of steps the owned-inline path runs inline (in
 * parallel) per suspension. The rest are queued to background handlers. Each
 * inline step is created lazily — its `step_created` is folded into the
 * `step_started` that `executeStep` sends — so inlining N steps saves N queue
 * round-trips for a `Promise.all`-style fan-out. `1` reproduces the
 * single-inline-step behavior exactly (useful kill-switch).
 *
 * Override via `WORKFLOW_MAX_INLINE_STEPS` (clamped to
 * `MIN_MAX_INLINE_STEPS`..`MAX_MAX_INLINE_STEPS`).
 */
export declare const MAX_INLINE_STEPS = 3;
/** Lower bound for the inline-steps env override (1 = single inline step). */
export declare const MIN_MAX_INLINE_STEPS = 1;
/**
 * Upper bound for the inline-steps env override. Inline bodies run in parallel
 * within one function invocation, so this caps memory/CPU fan-out per handler.
 */
export declare const MAX_MAX_INLINE_STEPS = 16;
/**
 * Resolve the effective max number of inline steps for the current process.
 *
 * Reads `process.env.WORKFLOW_MAX_INLINE_STEPS` lazily so tests and
 * deployments can override per invocation. Invalid / out-of-range values fall
 * back to a safe value (no throw — the env var is an escape hatch) and emit a
 * one-time warning so misconfiguration is observable.
 */
export declare function getMaxInlineSteps(): number;
/**
 * Upper bound on the serialized step input that resilient step dispatch will
 * inline into the queue message's `stepInput`.
 *
 * Vercel Queues has no hard message-size cap (bodies above its ~256 KB
 * inline threshold transparently spill to S3-backed storage), so this bound
 * is a cost/latency choice, not a rejection guard: the message also carries
 * the runId, stepId, stepName, and trace carrier alongside CBOR framing
 * overhead, and staying under the queue's inline threshold keeps step
 * messages on its fast inline path instead of paying an S3 store+fetch
 * double-hop for bytes that already live in the event log. Above this size
 * the dispatch falls back to the sequential path (`step_created` write, then
 * a payload-less queue message). Matches `MAX_INLINE_RESUME_PAYLOAD_BYTES`
 * on the resilient hook resume path.
 */
export declare const MAX_RESILIENT_STEP_INPUT_BYTES: number;
/**
 * Whether resilient step dispatch is enabled: the suspension handler
 * parallelizes each newly created step's `step_created` event write with its
 * step-execution queue publish, carrying the serialized step input in the
 * queue message (`stepInput`) so the consumer can idempotently re-ensure the
 * event if the direct write failed transiently. Mirrors the resilient start
 * (`runInput`) and resilient hook resume (`hookInput`) patterns.
 *
 * **Off by default.** Enable via `WORKFLOW_RESILIENT_STEP_DISPATCH=1`.
 *
 * The queue publish races the create's verdict, and a create can come back
 * refused — as a duplicate this replay should stop pursuing, or as a stale
 * write on a World that refuses rather than reports. Either way the message
 * carrying the payload is already out, so the consumer can materialize a step
 * whose create was refused, and nothing orders the verdict before the
 * consumer's redelivery re-ensure. Enabling this trades that window for the
 * latency the parallel publish saves.
 */
export declare function isResilientStepDispatchEnabled(): boolean;
/**
 * Whether batched event transitions are enabled: the suspension handler folds
 * a clean fan-out's `step_created` + `wait_created` writes into one
 * `world.events.createBatch` call (one durable write, per-event outcomes)
 * instead of one write per event. Only engages when the World implements the
 * optional `events.createBatch` AND the run is on slot identity
 * (specVersion >= 6) AND the suspension carries no attribute/hook writes and
 * no resilient step dispatch — everything else keeps the single-event path
 * byte-for-byte.
 *
 * Reads `process.env.WORKFLOW_BATCH_TRANSITIONS` lazily. Default **ON**;
 * disabled only by an explicit `'0'` / `'false'` (case-insensitive) — the
 * operator escape hatch that restores the exact prior one-write-per-event
 * path, mirroring `WORKFLOW_TURBO`'s kill-switch shape.
 */
export declare function isBatchTransitionsEnabled(): boolean;
/**
 * Ceiling on events per `createBatch` call from the batched fan-out fold.
 * Mirrors the server's transaction budgets with a comfortable margin: each
 * fan-out event costs 2 transaction items server-side (entity + event row)
 * against the 100-item DynamoDB cap, and inline payloads count against a
 * 768 KB byte budget — 32 events stays well under both, and a fan-out larger
 * than this simply commits in successive batches (split batches lose
 * cross-batch atomicity, which is exactly today's per-event-write crash
 * surface — every batch still converges on retry via per-event 409s).
 */
export declare const MAX_BATCH_FANOUT_EVENTS = 32;
/**
 * Optional client-side override for the server-supplied per-run event ceiling.
 * When set to a positive integer, the runtime clamps the server's limit *down*
 * to this value (never raises it) so enforcement can be exercised without a
 * server-side change. `undefined` (unset) ⇒ use the server value as-is.
 *
 * Reads `process.env.WORKFLOW_MAX_EVENTS_OVERRIDE` lazily so tests and
 * deployments can override per invocation. Invalid values fall back to unset
 * (no throw — the env var is an escape hatch) and emit a one-time warning.
 */
export declare function getMaxEventsOverride(): number | undefined;
/**
 * Whether optimistic inline step start is enabled. When on, the owned-inline
 * path begins running a brand-new step's body *before* its lazy `step_started`
 * network call resolves (the input is already known locally), awaiting the
 * `step_started` only before the terminal write.
 *
 * This can run a step body more than once when handlers race for the same
 * step's create-claim — both run the body before one wins. That is unsafe for
 * steps with non-idempotent side effects; in particular, two concurrent runs
 * of a step that writes to the workflow stream (e.g. an AI agent streaming
 * tokens) can interleave and corrupt the stream data. So the optimization is
 * **off by default** and must be explicitly opted into per deployment.
 *
 * Reads `process.env.WORKFLOW_OPTIMISTIC_INLINE_START` lazily. Default OFF;
 * enabled only by an explicit `'1'` / `'true'`.
 */
export declare function isOptimisticInlineStartEnabled(): boolean;
/**
 * Whether an operator has **explicitly disabled** optimistic inline start via
 * `WORKFLOW_OPTIMISTIC_INLINE_START=0` / `=false`. Distinct from "unset": unset
 * leaves the optimization off by default but lets turbo force it on; an explicit
 * `0`/`false` is an operator opt-out that turbo must honor (turbo's forced
 * optimistic start still runs a step body before `step_started`/`run_started` is
 * confirmed, the property such an operator is opting out of), so
 * `forceOptimisticStart` defers to this. Reads the env var lazily.
 */
export declare function isOptimisticInlineStartExplicitlyDisabled(): boolean;
/**
 * Whether "turbo mode" is enabled. Turbo mode fast-paths the *first delivery of
 * the first invocation* of a run (detected by the entrypoint via `runInput`
 * presence + `metadata.attempt === 1`): it backgrounds the `run_started` event
 * creation, skips the initial event-log load (nothing has been written yet),
 * and forces optimistic inline step start for that invocation — independent of
 * `WORKFLOW_OPTIMISTIC_INLINE_START`.
 *
 * Forcing optimistic start is safe here because the first delivery has no
 * concurrent peer handler to race the step create-claim, so a step body runs
 * exactly once. That single-handler guarantee ends as soon as the run creates a
 * hook or wait (which introduce resume/parallel invocations), so the runtime
 * exits turbo at that point.
 *
 * Reads `process.env.WORKFLOW_TURBO` lazily. Default **ON**; disabled only by an
 * explicit `'0'` / `'false'` (case-insensitive).
 */
export declare function isTurboEnabled(): boolean;
/**
 * Whether the QuickJS engine's baseline-snapshot startup optimization is
 * enabled (default ON). When on, the engine hydrates a VM with the
 * workflow bundle once per function instance, snapshots it, and starts
 * every invocation by restoring the snapshot instead of re-evaluating
 * the bundle — skipping the dominant share of VM startup (measured
 * ~77ms → ~3ms to first suspension for a 1.3MB bundle). Bundles whose
 * module scope consumes randomness, reads the clock, or replaces a
 * serialization intrinsic are detected at hydrate time and
 * automatically fall back to per-invocation fresh evaluation (see
 * prepareBaselineSnapshot). Set WORKFLOW_QUICKJS_BASELINE_SNAPSHOT=0 to
 * disable.
 */
export declare function isQuickJSBaselineSnapshotEnabled(): boolean;
/**
 * Whether the inline loop retains a suspended workflow VM across inline steps
 * within one invocation (default ON). When on, a step-only suspension keeps
 * the live VM, event consumer, and hydrated state alive, and the next loop
 * iteration appends only the newly durable events instead of rebuilding the
 * `vm.Context` and replaying the whole event log. Non-step suspensions and
 * replay divergence always fall back to the ordinary durable replay path.
 *
 * `WORKFLOW_RETAINED_VM=0` (or `false`) is the kill switch: every iteration
 * replays from scratch in a fresh VM, matching the pre-retention behavior.
 */
export declare function isVmRetentionEnabled(): boolean;
/**
 * Whether inline step ownership is enabled (default ON). When on, the lazy
 * `step_started` that creates an inline step records the owning queue
 * message ID, and wake replays that observe an actively-owned step enqueue a
 * *delayed backstop* message instead of immediately requeueing it — fixing
 * duplicate inline step execution when a hook/wait wakes a run mid-step
 * (vercel/workflow#2780).
 *
 * `WORKFLOW_INLINE_OWNERSHIP=0` (or `false`) is the kill switch: dispatch
 * reverts to the unconditional immediate requeue. Stamping is unaffected —
 * the recorded ownerMessageId is inert data when the switch is off.
 */
export declare function isInlineOwnershipEnabled(): boolean;
/**
 * Default inline-ownership lease, in seconds: how long after a step's latest
 * (stamped) `step_started` a non-owner invocation assumes the owning
 * invocation may still be alive. Within the lease, wake replays enqueue the
 * step's backstop message with `delaySeconds = lease remaining` instead of
 * immediately; past it, they enqueue immediately (today's behavior).
 *
 * Why a fixed 860 and not a value derived from the function's `maxDuration`:
 * neither runtime nor build time can see the resolved value — builders emit
 * `maxDuration: 'max'`, which the platform resolves per-plan at deploy, and
 * no env var or request-context deadline API exposes the result. The bound
 * comes from a platform rule instead: durations above 800s require explicit
 * per-function numeric config, so a builder-emitted `'max'` resolves to at
 * most 800s — 860s therefore dominates any workflow route's invocation
 * lifetime plus scheduling slack. Revisit when that ceiling moves (the
 * 30-minute duration beta becoming reachable via `'max'` would invalidate
 * the bound). Worlds without an invocation kill bound (world-local,
 * self-hosted) get no death proof from any constant — there the in-process
 * single-flight layer (step-single-flight.ts) is what makes a backstop
 * firing mid-step harmless.
 *
 * 860 also stays under the queue's 900s maximum delay (SQS cap), so a
 * backstop's full lease remainder always fits in a single delayed message.
 *
 * Override via `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS` (clamped to
 * 1..`MAX_INLINE_OWNERSHIP_LEASE_SECONDS`).
 */
export declare const INLINE_OWNERSHIP_LEASE_SECONDS = 860;
/**
 * Upper bound for the lease env override. 900s is the queue's maximum
 * per-message delay (SQS cap) — a longer lease would need delay chaining
 * like long waits use; clamp instead so one delayed message always suffices.
 */
export declare const MAX_INLINE_OWNERSHIP_LEASE_SECONDS = 900;
/**
 * Effective inline-ownership lease. Override via
 * `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS` — e.g. raise it on self-hosted
 * multi-instance worlds with long-running steps to widen the window in which
 * a live owner is protected from a concurrent backstop execution.
 */
export declare function getInlineOwnershipLeaseSeconds(): number;
export declare const REPLAY_DIVERGENCE_MAX_RETRIES = 3;
/**
 * Effective replay-divergence recovery budget. Override via
 * `WORKFLOW_REPLAY_DIVERGENCE_MAX_RETRIES`.
 */
export declare function getReplayDivergenceMaxRetries(): number;
export declare const PRECONDITION_MAX_INPROCESS_RESTARTS = 3;
/**
 * Effective in-process replay-restart budget for stale-snapshot rejections.
 * Override via `WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS`.
 */
export declare function getPreconditionMaxInProcessRestarts(): number;
export declare const PRECONDITION_MAX_REINVOCATIONS = 5;
/**
 * Effective per-run budget for re-invocations caused by stale-snapshot
 * rejections. Override via `WORKFLOW_PRECONDITION_MAX_REINVOCATIONS`.
 */
export declare function getPreconditionMaxReinvocations(): number;
export declare const PRECONDITION_REINVOKE_DELAY_SECONDS = 2;
/**
 * Effective delay before a precondition re-invocation. Override via
 * `WORKFLOW_PRECONDITION_REINVOKE_DELAY_SECONDS`.
 */
export declare function getPreconditionReinvokeDelaySeconds(): number;
export declare const DEPLOYMENT_MISMATCH_MAX_RETRIES = 3;
/**
 * Effective deployment-mismatch re-route budget. Override via
 * `WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES`; `0` fails the run on the first
 * misrouted delivery instead of attempting recovery.
 */
export declare function getDeploymentMismatchMaxRetries(): number;
//# sourceMappingURL=constants.d.ts.map