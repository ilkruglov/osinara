import type { ModelMessage } from "ai";
import type { InputRequest } from "#runtime/input/types.js";
import type { HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";
/**
 * Stream-emit coordinates carried so a parked batch's resolution can attribute
 * its events to the turn and step that requested the input.
 */
export interface PendingInputBatchEvent {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
}
/**
 * Serializable pending input batch stored on the session state: one parked
 * assistant turn's requests plus its withheld model output.
 */
export interface PendingInputBatch {
    readonly event?: PendingInputBatchEvent;
    readonly requests: readonly InputRequest[];
    readonly responseAuthRequiredRequestIds?: readonly string[];
    readonly responseMessages: readonly ModelMessage[];
}
/**
 * Returns true when the session holds at least one pending HITL batch
 * (tool approvals or `ask_question` prompts).
 */
export declare function hasPendingInputBatch(state: SessionStateMap | undefined): boolean;
/**
 * Returns the request IDs across every pending HITL batch.
 */
export declare function getPendingInputRequestIds(state: SessionStateMap | undefined): ReadonlySet<string>;
/**
 * Reads the ordered pending batches. Sessions parked before the collection
 * shape carry the legacy singleton key; it reads as a one-element list and
 * is rewritten to the list shape on the next batch write.
 */
export declare function getPendingInputBatches(state: SessionStateMap | undefined): readonly PendingInputBatch[];
/**
 * Removes the given batches (matched by identity from a prior
 * {@link getPendingInputBatches} read) and keeps every other batch open.
 *
 * Removal is the only exported way to shrink the collection: a wholesale
 * setter would reintroduce the overwrite hazard the collection exists to
 * prevent — a writer clobbering batches it never resolved.
 */
export declare function removePendingInputBatches(session: HarnessSession, batches: readonly PendingInputBatch[]): HarnessSession;
/**
 * Appends one pending HITL batch for a parked assistant turn. Earlier
 * batches stay open and independently answerable.
 */
export declare function appendPendingInputBatch(input: {
    readonly event?: PendingInputBatchEvent;
    readonly requests: readonly InputRequest[];
    readonly responseAuthRequiredRequestIds?: readonly string[];
    readonly responseMessages: readonly ModelMessage[];
    readonly session: HarnessSession;
}): HarnessSession;
/**
 * Merges any queued follow-up input into the current step input and clears it
 * from session state. When `preferCurrentInput` is set, fresh input is returned
 * alone and the queued input remains deferred.
 *
 * Used when the harness has to process a pending tool-approval response first
 * and defer the user's new message to the next internal model step.
 */
export declare function consumeDeferredStepInput(input: {
    readonly input?: StepInput;
    readonly preferCurrentInput?: boolean;
    readonly session: HarnessSession;
}): {
    readonly input?: StepInput;
    readonly session: HarnessSession;
};
/**
 * Returns true when the session carries queued follow-up input for the next
 * internal harness step.
 */
export declare function hasDeferredStepInput(session: HarnessSession): boolean;
export declare function queueDeferredStepInput(session: HarnessSession, input: StepInput): HarnessSession;
