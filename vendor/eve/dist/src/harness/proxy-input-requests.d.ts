import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { InputRequestKind } from "#runtime/input/types.js";
/** Routing and control metadata for one descendant-owned input request. */
export interface ProxyInputRequest {
    /** Batch semantics are optional so sessions written before this field remain routable. */
    readonly batch?: ProxyInputRequestBatch;
    readonly childContinuationToken: string;
    /** Child-local id restored before forwarding a namespaced task response. */
    readonly childRequestId?: string;
    /** Trusted parent-derived capability URL for a remote task child. */
    readonly childResponseUrl?: string;
    readonly kind: InputRequestKind;
    /** Present when the route is authorized by a parent-owned durable task. */
    readonly taskId?: string;
}
export interface ProxyInputRequestBatch {
    readonly approvalRequestIds: readonly string[];
    readonly requestIds: readonly string[];
}
/** Parent-visible id for one task-owned child-local input request. */
export declare function createTaskInputRequestId(taskId: string, childRequestId: string): string;
/**
 * Returns the proxy-routing map as a fresh `Map`. Never returns a live
 * reference so accidental mutation cannot corrupt session state.
 */
export declare function getProxyInputRequests(state: SessionStateMap | undefined): ReadonlyMap<string, ProxyInputRequest>;
/**
 * Returns true when the session is currently proxying one or more
 * HITL requests on behalf of a descendant subagent.
 */
export declare function hasProxyInputRequests(state: SessionStateMap | undefined): boolean;
/**
 * Replaces prior entries for `forChildContinuationToken` with the provided
 * ones. A child raising a fresh batch overwrites its prior batch so the
 * parent never keeps stale request metadata. Other children's routes stay
 * independently answerable.
 */
export declare function upsertProxyInputRequests(input: {
    readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
    readonly forChildContinuationToken: string;
    readonly session: HarnessSession;
}): HarnessSession;
/** State-only variant for control-plane steps that already hold a durable projection. */
export declare function upsertProxyInputRequestState(input: {
    readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
    readonly forChildContinuationToken: string;
    readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined;
/**
 * Removes every entry for `childContinuationToken`. Called when a
 * child subagent finishes so stale clicks no longer route to it.
 */
export declare function clearProxyInputRequestsForChild(session: HarnessSession, childContinuationToken: string): HarnessSession;
/** Removes only the request IDs whose responses were successfully forwarded. */
export declare function retireProxyInputRequests<T extends {
    readonly state?: SessionStateMap;
}>(session: T, requestIds: readonly string[]): T;
/** Removes every proxy route owned by one durable task. */
export declare function clearProxyInputRequestsForTask(session: HarnessSession, taskId: string): HarnessSession;
/**
 * Removes every proxy entry. Called when a cancelled turn orphans its
 * descendants so stale HITL responses no longer route to them.
 */
export declare function clearAllProxyInputRequests(session: HarnessSession): HarnessSession;
/**
 * Projects a {@link SubagentInputRequestHookPayload} into the
 * `(requestId, route)` tuples the session stores.
 */
export declare function toProxyInputRequestEntries(payload: SubagentInputRequestHookPayload, taskId?: string): readonly (readonly [requestId: string, route: ProxyInputRequest])[];
