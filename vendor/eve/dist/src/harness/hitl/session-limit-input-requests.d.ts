import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import type { InputDomainResolverInput, ResolvePendingInputResult } from "#harness/hitl/pending-input-resolution.js";
import type { HarnessSession } from "#harness/types.js";
/** Returns whether this is a valid session-limit batch and rejects mixed ownership. */
export declare function isSessionLimitInputBatch(batch: PendingInputBatch): boolean;
export declare function resolveSessionLimitInput(input: InputDomainResolverInput & {
    readonly pendingBatch: PendingInputBatch;
}): ResolvePendingInputResult;
/** Drops only harness-authored session-limit prompts from a parked session. */
export declare function clearPendingSessionLimitPrompt(session: HarnessSession): HarnessSession;
