import { type WorkflowRun, type World } from '#compiled/@workflow/world/index.js';
/**
 * How the guard resolved a delivery. Both non-`continue` outcomes mean the
 * caller must ack the message and return without executing anything.
 */
export type DeploymentAffinityOutcome = 
/** The run belongs here (or this world has no deployment affinity). */
'continue'
/** Misrouted; re-enqueued at the run's own deployment. */
 | 'rerouted'
/** Misrouted and out of budget (or unroutable); `run_failed` recorded. */
 | 'failed';
/**
 * `spanAttributes` is present only on a misrouted delivery — mismatches are
 * rare, so the presence of `workflow.deployment.pinned_id` on a span *is* the
 * signal that one happened, and `recovered` separates the ones a re-route fixed
 * from the ones that kept misrouting.
 */
export interface DeploymentAffinityResult {
    outcome: DeploymentAffinityOutcome;
    spanAttributes?: Record<string, string | number | boolean>;
}
/**
 * Arguments handed to a call site's re-enqueue closure. The guard owns the
 * policy — counting, backoff, logging, telemetry, escalation — and the call
 * site owns only the shape of the message it needs to put back on the queue.
 */
export interface ReenqueueArgs {
    /** The deployment to target: the one the run is pinned to. */
    deploymentId: string;
    /**
     * The run's spec version, so the world picks the right queue transport
     * (CBOR vs JSON). Undefined on legacy runs that predate the field; worlds
     * then fall back to their current default.
     */
    specVersion: number | undefined;
    deploymentMismatchRetryCount: number;
    /** Backoff before the re-routed message becomes visible. */
    delaySeconds: number;
}
/**
 * Guards deployment affinity: a run may only execute on the deployment it is
 * pinned to.
 *
 * A run's `deploymentId` is fixed when it starts — the deployment that called
 * `start()`, or whatever `start({ deploymentId })` resolved to (an explicit id
 * or `'latest'`) — and no replay or step execution may happen anywhere else:
 * the bundles here may not match the run's persisted history, and any step
 * dispatched from here derives the per-run encryption key from the wrong
 * deployment's master key, which surfaces as a `RuntimeDecryptionError` the
 * queue retry callback swallows into a blank "exceeded max retries".
 *
 * A misrouted delivery is not treated as permanent. Rather than failing
 * immediately, re-enqueue the message *explicitly targeted* at the run's own
 * deployment; that send is strictly better-addressed than the one that
 * misrouted, which inherited the producing deployment's ambient id. Fail only
 * once the budget (`WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES`, default 3) is
 * spent, mirroring how a replay divergence gets bounded recovery replays before
 * being recorded as a corrupted event log.
 *
 * Callers must pass a run entity they already have in hand — every call site
 * loads the run for other reasons — so the guard costs no extra round trip.
 * (`world.getDeploymentId()` reads the ambient deployment id, e.g.
 * `VERCEL_DEPLOYMENT_ID`, and does not call the backend either.)
 *
 * The failure is recorded **without resolving the run's encryption key**: the
 * key is fetched from the pinned deployment's API, often unavailable once that
 * deployment is past its retention window, so depending on it would throw here
 * instead of recording the failure. The payload is written unencrypted (it
 * holds only deployment ids, nothing sensitive), and the plaintext `errorCode`
 * is the signal observability and the UI key off.
 */
export declare function guardDeploymentAffinity({ world, run, requestId, retryCount, reenqueue, isDeploymentUnavailableError, beforeStop, }: {
    world: World;
    run: Pick<WorkflowRun, 'runId' | 'deploymentId' | 'specVersion'>;
    requestId?: string;
    /** `deploymentMismatchRetryCount` from the incoming message, if any. */
    retryCount?: number;
    /**
     * Puts this delivery's message back on the queue, targeted at the run's own
     * deployment. Omitted by callers that cannot reconstruct their message, which
     * makes the guard fail-fast.
     */
    reenqueue?: (args: ReenqueueArgs) => Promise<void>;
    /**
     * Classifies a re-enqueue failure as definitive proof that the pinned
     * deployment cannot receive the message. Unclassified failures are retried
     * by rejecting the handler and leaving the current queue message unacked.
     */
    isDeploymentUnavailableError?: (error: unknown) => boolean;
    /**
     * Ordering barrier awaited once a mismatch is confirmed, before either
     * stopping action. Under turbo the `run_started` write is backgrounded, and
     * both outcomes hand the run off (to a `run_failed` here, or to the pinned
     * deployment's own `run_started`) — so that write must have landed first.
     */
    beforeStop?: () => Promise<void>;
}): Promise<DeploymentAffinityResult>;
//# sourceMappingURL=deployment-guard.d.ts.map