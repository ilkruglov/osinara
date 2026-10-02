import { type AuthorizationChallenge } from "#harness/authorization.js";
import type { HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";
export interface ApprovalDeliveryResult {
    readonly challenges: readonly AuthorizationChallenge[];
    readonly feedback: readonly string[];
    readonly kind: "continue" | "continue-coordination" | "authorization-required" | "park";
    readonly session: HarnessSession;
    readonly stepInput?: StepInput;
}
/**
 * Advances approval state by one durable phase.
 *
 * | State | Input | Transition |
 * | --- | --- | --- |
 * | pending request | Approve | create responder-bound candidate |
 * | pending request | Cancel | settle cancelled and stale candidates |
 * | pending candidate | coordinator pass | run current authorizer |
 * | pending candidate | allowed | settle approved and stale competitors |
 * | pending candidate | rejected/error/expiry | append terminal history |
 * | pending candidate | authorization required | persist private challenge |
 * | authorization required | matching callback | re-run current authorizer |
 * | settled request | any later response | no state change |
 *
 * Delivery ingestion returns before authorizer work so Cancel and candidate
 * creation commit before long-running policy execution. Candidate results also
 * commit before lifecycle events are projected by the next stack layer.
 */
/** Returns whether this invocation should prepare tools for persisted policy work. */
export declare function shouldPrepareApprovalPolicyTools(input: {
    readonly now?: number;
    readonly session: HarnessSession;
    readonly stepInput?: StepInput;
}): boolean;
export declare function coordinateApprovalDelivery(input: {
    readonly now?: number;
    readonly session: HarnessSession;
    readonly stepInput?: StepInput;
    readonly tools: HarnessToolMap;
}): Promise<ApprovalDeliveryResult>;
