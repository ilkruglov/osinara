import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import type { InputDomainResolverInput, ResolvedInputActionBatch, ResolvePendingInputResult } from "#harness/hitl/pending-input-resolution.js";
import type { HarnessSession } from "#harness/types.js";
export type RejectedActionBatch = ResolvedInputActionBatch;
export declare function hasAnsweredApprovalBatch(batches: readonly PendingInputBatch[], responses: readonly InputResponse[]): boolean;
export declare function resolveApprovalInputBatches(input: InputDomainResolverInput & {
    readonly approvalBatches: readonly PendingInputBatch[];
    readonly questionBatches: readonly PendingInputBatch[];
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
}): ResolvePendingInputResult;
/** Returns tool approval keys recorded during this session. */
export declare function getApprovedTools(session: HarnessSession): ReadonlySet<string>;
