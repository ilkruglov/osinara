import type { DeliverPayload } from "#channel/types.js";
import type { AuthorizationResult, PendingAuthorizationState } from "#harness/authorization.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
export interface MatchedAuthorizationCallback {
    readonly authorization: ConnectionAuthorizationChallenge;
    readonly result: {
        readonly name: string;
    } & AuthorizationResult;
}
/** Matches current callbacks by attempt ID and legacy callbacks only to legacy state. */
export declare function matchAuthorizationCallbacks(pending: PendingAuthorizationState, payloads: readonly DeliverPayload[]): {
    readonly matches: readonly MatchedAuthorizationCallback[];
    readonly remainingPayloads: readonly DeliverPayload[];
};
