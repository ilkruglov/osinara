import type { ModelMessage } from "ai";
import type { RuntimeToolResultActionResult } from "#runtime/actions/types.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import type { PendingInputBatch, PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
export type ToolResponsePart = Extract<ModelMessage, {
    role: "tool";
}>["content"][number];
/** Action results from one resolved batch, attributed to their originating turn. */
export interface ResolvedInputActionBatch {
    readonly event: PendingInputBatchEvent;
    readonly results: readonly RuntimeToolResultActionResult[];
}
export type ResolvedStepInput = StepInput & {
    readonly messageConsumed?: boolean;
};
export type InputDomainResolverInput = {
    readonly baseHistory: ModelMessage[];
    readonly batches: readonly PendingInputBatch[];
    readonly deferTurnInput: boolean;
    readonly resolvedStepInput: ResolvedStepInput | undefined;
    readonly responses: readonly InputResponse[];
    readonly session: HarnessSession;
};
export type ResolvePendingInputResult = {
    readonly consumedMessage?: boolean;
    readonly deferredContext?: boolean;
    readonly deferredMessage?: boolean;
    /** Present when a session-limit continuation prompt was resolved. */
    readonly limitContinuation?: {
        readonly granted: boolean;
    };
    readonly outcome: "resolved" | "continue" | "unresolved";
    readonly messages: ModelMessage[];
    readonly rejectedActions?: readonly ResolvedInputActionBatch[];
    readonly resolvedInputs?: readonly ResolvedInputBatch[];
    readonly session: HarnessSession;
};
export declare function responsesForBatches(responses: readonly InputResponse[], batches: readonly PendingInputBatch[]): readonly InputResponse[];
export declare function appendResolvedBatchTranscript(messages: ModelMessage[], batch: PendingInputBatch, toolParts: readonly ToolResponsePart[]): void;
export declare function finishResolvedInput(input: {
    readonly deferTurnInput: boolean;
    readonly leftoverResponses: readonly InputResponse[];
    readonly limitContinuation?: {
        readonly granted: boolean;
    };
    readonly messages: ModelMessage[];
    readonly rejectedActions?: readonly ResolvedInputActionBatch[];
    readonly resolvedInputs?: readonly ResolvedInputBatch[];
    readonly resolvedStepInput: ResolvedStepInput | undefined;
    readonly session: HarnessSession;
}): ResolvePendingInputResult;
export declare function compactStepInput(input: ResolvedStepInput | undefined): ResolvedStepInput;
