import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";
export type ApprovalCandidateStatus = "pending" | "authorization-required" | "allowed" | "rejected" | "failed" | "timed-out" | "stale";
export interface ApprovalCandidateAuditRecord {
    readonly candidateId: string;
    readonly requestId: string;
    readonly responder: ApprovalResponderIdentity;
    readonly status: ApprovalCandidateStatus;
    readonly createdAt: number;
    readonly completedAt?: number;
    readonly eventEmitted?: boolean;
    readonly expiresAt?: number;
    readonly reason?: string;
}
export interface ApprovalResponderIdentity {
    readonly authenticator: string;
    readonly issuer?: string;
    readonly principalId: string;
    readonly principalType: string;
}
export interface ApprovalSettlementAuditRecord {
    readonly actor: ApprovalResponderIdentity;
    readonly outcome: "allowed" | "cancelled";
    readonly requestId: string;
    readonly settledAt: number;
    readonly candidateId?: string;
    readonly eventEmitted?: boolean;
}
export interface ActiveApprovalCandidate {
    readonly candidateId: string;
    readonly requestId: string;
    readonly responder: SessionAuthContext;
    readonly status: "pending" | "authorization-required";
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly authorizationChallenges?: readonly AuthorizationChallenge[];
    readonly pendingEventEmitted?: boolean;
}
export interface ApprovalStateTransition {
    readonly changed: boolean;
    readonly state: SessionStateMap | undefined;
}
/** Creates or deduplicates one responder's Allow candidate for a pending request. */
export declare function createApprovalCandidate(input: {
    readonly candidateIdPrefix: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly requestId: string;
    readonly responder: SessionAuthContext;
    readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition;
/** Marks the pending candidate event as emitted. */
export declare function markApprovalCandidatePendingEventEmitted(input: {
    readonly candidateId: string;
    readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined;
/** Marks a terminal candidate history event as emitted. */
export declare function markApprovalCandidateHistoryEventEmitted(input: {
    readonly candidateId: string;
    readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined;
/** Marks a terminal settlement event as emitted. */
export declare function markApprovalSettlementEventEmitted(input: {
    readonly requestId: string;
    readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined;
/** Marks a candidate as waiting on a private authorization challenge. */
export declare function markApprovalCandidateAuthorizationRequired(input: {
    readonly authorizationChallenges: readonly AuthorizationChallenge[];
    readonly candidateId: string;
    readonly expiresAt?: number;
    readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined;
/** Finishes one candidate without settling the shared request. */
export declare function finishApprovalCandidate(input: {
    readonly candidateId: string;
    readonly completedAt: number;
    readonly reason?: string;
    readonly state: SessionStateMap | undefined;
    readonly status: Exclude<ApprovalCandidateStatus, "pending" | "authorization-required">;
}): SessionStateMap | undefined;
/** Expires active candidates whose deterministic deadline has passed. */
export declare function expireApprovalCandidates(input: {
    readonly now: number;
    readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined;
/** Atomically settles an allowed candidate; every losing candidate becomes stale. */
export declare function settleAllowedCandidate(input: {
    readonly candidateId: string;
    readonly settledAt: number;
    readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition;
/** Atomically settles a direct authenticated approval response. */
export declare function settleDirectApprovalResponse(input: {
    readonly actor: SessionAuthContext;
    readonly outcome: "allowed" | "cancelled";
    readonly requestId: string;
    readonly settledAt: number;
    readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition;
/** Returns one active candidate by id. */
export declare function getActiveApprovalCandidate(state: SessionStateMap | undefined, candidateId: string): ActiveApprovalCandidate | undefined;
/** Returns a copy of the durable candidate/audit state for inspection and replay. */
export declare function getApprovalAuditState(state: SessionStateMap | undefined): {
    readonly activeCandidates: readonly ActiveApprovalCandidate[];
    readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
    readonly settlements: readonly ApprovalSettlementAuditRecord[];
};
