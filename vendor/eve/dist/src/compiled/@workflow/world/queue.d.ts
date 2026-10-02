import { z } from '#compiled/zod/index.js';
export type QueueKind = 'workflow';
/**
 * Pattern matching valid queue prefixes:
 * - `__wkf_workflow_` (default, no namespace)
 * - `__{namespace}_wkf_workflow_` (namespaced)
 *
 * Namespace must be lowercase alphanumeric starting with a letter.
 */
export declare const QueuePrefix: z.ZodString;
export type QueuePrefix = z.infer<typeof QueuePrefix>;
export declare const ValidQueueName: z.ZodString;
export type ValidQueueName = z.infer<typeof ValidQueueName>;
/**
 * Resolves the active queue namespace from an explicit argument or the
 * `WORKFLOW_QUEUE_NAMESPACE` env var.
 */
export declare function resolveQueueNamespace(namespace?: string): string | undefined;
/**
 * Builds the workflow queue topic prefix for an optional namespace.
 *
 * The literal kind argument is retained so existing workflow-only callers keep
 * their meaning after removal of the former `'step'` variant.
 *
 * - `getQueueTopicPrefix('workflow')` → `'__wkf_workflow_'`
 * - `getQueueTopicPrefix('workflow', 'custom')` → `'__custom_wkf_workflow_'`
 */
export declare function getQueueTopicPrefix(kind: QueueKind, namespace?: string): QueuePrefix;
export declare function parseQueueName(name: ValidQueueName): {
    prefix: QueuePrefix;
    id: string;
};
export declare const MessageId: z.core.$ZodBranded<z.ZodString, "MessageId", "out">;
export type MessageId = z.infer<typeof MessageId>;
/**
 * OpenTelemetry trace context for distributed tracing
 */
export declare const TraceCarrierSchema: z.ZodRecord<z.ZodString, z.ZodString>;
export type TraceCarrier = z.infer<typeof TraceCarrierSchema>;
/**
 * Run creation data carried through the queue for resilient start.
 * Only present on the first queue delivery — re-enqueues omit this.
 * When the runtime processes the message, it passes this data to the
 * run_started event so the server can create the run if it doesn't exist yet.
 */
export declare const RunInputSchema: z.ZodObject<{
    input: z.ZodUnknown;
    deploymentId: z.ZodString;
    workflowName: z.ZodString;
    specVersion: z.ZodNumber;
    executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    attributes: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    allowReservedAttributes: z.ZodOptional<z.ZodLiteral<true>>;
    environment: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type RunInput = z.infer<typeof RunInputSchema>;
/**
 * Lazy hook resume data carried through the queue alongside a workflow
 * invocation. Present only when `resumeHook()` takes the parallel fast path:
 * the producer persists the `hook_received` event and publishes this invocation
 * concurrently. On receipt, a consumer that understands `hookInput` idempotently
 * ensures the `hook_received` event exists — keyed by `resumeId` — before
 * replaying, so the two concurrent writes converge on exactly one event.
 *
 * The `payload` is the already-serialized (and possibly encrypted) resume
 * payload — the identical bytes the producer also sent on the direct
 * `events.create`, so both server receipts hash to the same digest under the
 * `(runId, resumeId)` constraint.
 */
/**
 * Resilient step dispatch data carried through the queue alongside a
 * step-execution message ({@link WorkflowInvokePayload.stepId}). Present when
 * the producer (the suspension handler dispatching a newly created step)
 * parallelized the `step_created` event write with the queue publish — the
 * same shape as resilient start (`runInput`) and the resilient hook resume
 * (`hookInput`).
 *
 * When the producer's `step_created` write fails transiently (429 / 5xx /
 * transport), the step entity may not exist when this message is consumed. A
 * consumer that understands `stepInput` idempotently re-ensures the
 * `step_created` event — keyed by the message's `stepId` (the step's
 * correlation id, unique per `(runId, correlationId)`) — before executing, so
 * the producer's write and the consumer's re-ensure converge on exactly one
 * event.
 *
 * The `input` is the already-serialized (and possibly encrypted) step input —
 * the identical bytes the producer also sent on the direct `events.create`.
 */
export declare const StepDispatchInputSchema: z.ZodObject<{
    input: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
}, z.core.$strip>;
export type StepDispatchInput = z.infer<typeof StepDispatchInputSchema>;
export declare const HookResumeInputSchema: z.ZodObject<{
    resumeId: z.ZodString;
    hookId: z.ZodString;
    token: z.ZodString;
    payload: z.ZodUnknown;
    payloadDigest: z.ZodString;
    deploymentId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type HookResumeInput = z.infer<typeof HookResumeInputSchema>;
/**
 * Wall-clock boundaries of a hook-triggered resume, carried on the queue
 * message so the SDK can report end-to-end time-to-resume (TTR) — entry into
 * `resumeHook()` through to the first line of the next durable step — and its
 * non-overlapping phase breakdown, as span attributes on that step's
 * `step.execute` span. See `runtime/resume-latency.ts` in `@workflow/core`.
 *
 * Two groups of fields:
 *
 * - Producer fields (`resumeRequestedAtMs`, `queuePublishRequestedAtMs`,
 *   `strategy`) are stamped by `resumeHook()` on the invocation message. They
 *   ride along on a deployment-affinity re-route unchanged, so a misrouted
 *   delivery's extra hop stays inside `queue_delivery`.
 * - Consumer fields (`consumerStartedAtMs`, `replayStartedAtMs`,
 *   `nextStepEncounteredAtMs`, `setupSource`) are filled in by the invocation
 *   that replayed the resume, and ONLY when it dispatches the next durable
 *   step to a separate queue invocation instead of running it inline. They let
 *   that invocation report the same single TTR measurement.
 *
 * Every field is advisory and the whole object is optional, in all three
 * directions that matter for a rolling deploy: a new producer's timing is
 * ignored by an old consumer, a new consumer simply reports no TTR for an old
 * message, and workflow-server never reads it at all.
 *
 * `strategy` and `setupSource` are deliberately typed as plain strings rather
 * than enums: an unrecognized value from a newer producer must not fail the
 * parse of the whole invocation payload (which would wedge the run) — it is
 * only ever forwarded to a span attribute.
 */
export declare const HookResumeTimingSchema: z.ZodObject<{
    resumeRequestedAtMs: z.ZodNumber;
    queuePublishRequestedAtMs: z.ZodNumber;
    strategy: z.ZodOptional<z.ZodString>;
    consumerStartedAtMs: z.ZodOptional<z.ZodNumber>;
    replayStartedAtMs: z.ZodOptional<z.ZodNumber>;
    nextStepEncounteredAtMs: z.ZodOptional<z.ZodNumber>;
    setupSource: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type HookResumeTiming = z.infer<typeof HookResumeTimingSchema>;
export declare const WorkflowInvokePayloadSchema: z.ZodObject<{
    runId: z.ZodString;
    traceCarrier: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    requestedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    replayDivergence: z.ZodOptional<z.ZodObject<{
        eventId: z.ZodString;
        count: z.ZodNumber;
    }, z.core.$strip>>;
    preconditionReinvocations: z.ZodOptional<z.ZodNumber>;
    serverErrorRetryCount: z.ZodOptional<z.ZodNumber>;
    deploymentMismatchRetryCount: z.ZodOptional<z.ZodNumber>;
    stepId: z.ZodOptional<z.ZodString>;
    stepName: z.ZodOptional<z.ZodString>;
    runInput: z.ZodOptional<z.ZodObject<{
        input: z.ZodUnknown;
        deploymentId: z.ZodString;
        workflowName: z.ZodString;
        specVersion: z.ZodNumber;
        executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
        attributes: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        allowReservedAttributes: z.ZodOptional<z.ZodLiteral<true>>;
        environment: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    hookInput: z.ZodOptional<z.ZodObject<{
        resumeId: z.ZodString;
        hookId: z.ZodString;
        token: z.ZodString;
        payload: z.ZodUnknown;
        payloadDigest: z.ZodString;
        deploymentId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    stepInput: z.ZodOptional<z.ZodObject<{
        input: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
    }, z.core.$strip>>;
    hookResumeTiming: z.ZodCatch<z.ZodOptional<z.ZodObject<{
        resumeRequestedAtMs: z.ZodNumber;
        queuePublishRequestedAtMs: z.ZodNumber;
        strategy: z.ZodOptional<z.ZodString>;
        consumerStartedAtMs: z.ZodOptional<z.ZodNumber>;
        replayStartedAtMs: z.ZodOptional<z.ZodNumber>;
        nextStepEncounteredAtMs: z.ZodOptional<z.ZodNumber>;
        setupSource: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type WorkflowInvokePayload = z.infer<typeof WorkflowInvokePayloadSchema>;
export type HealthCheckPayload = z.infer<typeof HealthCheckPayloadSchema>;
/**
 * Health check payload - used to verify that the queue pipeline
 * can deliver messages to the combined workflow endpoint.
 */
export declare const HealthCheckPayloadSchema: z.ZodObject<{
    __healthCheck: z.ZodLiteral<true>;
    correlationId: z.ZodString;
    runId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Health check MUST come first.
 *
 * Zod unions return the first matching member's output, and `z.object` strips
 * keys the matching member doesn't declare. `HealthCheckPayloadSchema` carries
 * an optional `runId`, so a probe payload also satisfies
 * `WorkflowInvokePayloadSchema` (whose only required field is `runId`). With
 * the invoke member first, parsing a runId-bearing probe silently dropped
 * `__healthCheck` and `correlationId`, and the runtime — which dispatches on
 * `__healthCheck` before falling through to the invoke schema — reinterpreted
 * the probe as "replay this run". That made the queue handler POST
 * `run_started` for a run that doesn't exist yet (404), fail, and retry
 * forever, so the probe never answered and `start()` timed out.
 *
 * Ordering health check first is safe in the other direction: it requires
 * `__healthCheck: true`, which an invoke payload never carries.
 */
export declare const QueuePayloadSchema: z.ZodUnion<readonly [z.ZodObject<{
    __healthCheck: z.ZodLiteral<true>;
    correlationId: z.ZodString;
    runId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    traceCarrier: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    requestedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    replayDivergence: z.ZodOptional<z.ZodObject<{
        eventId: z.ZodString;
        count: z.ZodNumber;
    }, z.core.$strip>>;
    preconditionReinvocations: z.ZodOptional<z.ZodNumber>;
    serverErrorRetryCount: z.ZodOptional<z.ZodNumber>;
    deploymentMismatchRetryCount: z.ZodOptional<z.ZodNumber>;
    stepId: z.ZodOptional<z.ZodString>;
    stepName: z.ZodOptional<z.ZodString>;
    runInput: z.ZodOptional<z.ZodObject<{
        input: z.ZodUnknown;
        deploymentId: z.ZodString;
        workflowName: z.ZodString;
        specVersion: z.ZodNumber;
        executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
        attributes: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        allowReservedAttributes: z.ZodOptional<z.ZodLiteral<true>>;
        environment: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    hookInput: z.ZodOptional<z.ZodObject<{
        resumeId: z.ZodString;
        hookId: z.ZodString;
        token: z.ZodString;
        payload: z.ZodUnknown;
        payloadDigest: z.ZodString;
        deploymentId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    stepInput: z.ZodOptional<z.ZodObject<{
        input: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
    }, z.core.$strip>>;
    hookResumeTiming: z.ZodCatch<z.ZodOptional<z.ZodObject<{
        resumeRequestedAtMs: z.ZodNumber;
        queuePublishRequestedAtMs: z.ZodNumber;
        strategy: z.ZodOptional<z.ZodString>;
        consumerStartedAtMs: z.ZodOptional<z.ZodNumber>;
        replayStartedAtMs: z.ZodOptional<z.ZodNumber>;
        nextStepEncounteredAtMs: z.ZodOptional<z.ZodNumber>;
        setupSource: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>]>;
export type QueuePayload = z.infer<typeof QueuePayloadSchema>;
export interface QueueOptions {
    deploymentId?: string;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    /** Delay message delivery by this many seconds */
    delaySeconds?: number;
    /** Spec version of the target run. Used to select the queue transport format. */
    specVersion?: number;
    /**
     * World-specific routing hint identifying the region the message should
     * be sent to (e.g. a Vercel compute region code such as `'iad1'`).
     *
     * Worlds that don't have a regional dimension ignore this field. For
     * `@workflow/world-vercel`, this overrides the region the underlying
     * `@vercel/queue` client uses to route the message; when omitted, the
     * region is resolved from the payload's tagged run ID, then from the
     * `VERCEL_REGION` environment variable, and finally defaults to `'iad1'`
     * (the pre-regional-routing behaviour).
     */
    region?: string;
}
export interface Queue {
    getDeploymentId(): Promise<string>;
    /**
     * Returns true only when a queue error definitively means the explicitly
     * targeted deployment cannot receive the message. Unknown and transient
     * errors must return false so the current delivery can be retried safely.
     */
    isDeploymentUnavailableError?(error: unknown): boolean;
    /**
     * Enqueues a message to the specified queue.
     *
     * @param queueName - The name of the queue to which the message will be sent.
     * @param message - The content of the message to be sent to the queue.
     * @param opts - Optional parameters for the queue operation.
     */
    queue(queueName: ValidQueueName, message: QueuePayload, opts?: QueueOptions): Promise<{
        messageId: MessageId | null;
    }>;
    /**
     * Creates an HTTP queue handler for processing messages from a specific queue.
     * A rejected handler must retry the same message with an incremented attempt.
     *
     * `meta.messageId` SHOULD be stable across redeliveries of the same message
     * (one ID per enqueued message, reused on every delivery attempt). The
     * runtime's inline step ownership uses it as a liveness lease: the lazy
     * `step_started` records the handling invocation's messageId, and only a
     * delivery of that same message may re-execute the step before the
     * ownership lease expires (crash recovery via queue redelivery). A World
     * whose queue mints a fresh ID per delivery degrades gracefully — owner
     * redeliveries fall back to the delayed-backstop path instead of executing
     * immediately, adding recovery latency but never wedging or duplicating.
     */
    createQueueHandler(queueNamePrefix: QueuePrefix, handler: (message: unknown, meta: {
        attempt: number;
        queueName: ValidQueueName;
        messageId: MessageId;
        requestId?: string;
    }) => Promise<void | {
        timeoutSeconds: number;
    }>): (req: Request) => Promise<Response>;
}
//# sourceMappingURL=queue.d.ts.map