import type { ModelMessage } from "ai";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import type { InputDomainResolverInput, ResolvePendingInputResult, ToolResponsePart } from "#harness/hitl/pending-input-resolution.js";
export type QuestionInputRequest = InputRequest & {
    readonly kind: "question";
};
export declare function resolveQuestionOnlyInputBatches(input: InputDomainResolverInput): ResolvePendingInputResult;
export declare function findAnsweredQuestionBatches(batches: readonly PendingInputBatch[], responses: readonly InputResponse[]): PendingInputBatch[];
export declare function resolveQuestionBatches(input: {
    readonly batches: readonly PendingInputBatch[];
    readonly messages: ModelMessage[];
    readonly responses: readonly InputResponse[];
}): ModelMessage[];
export declare function buildQuestionToolResponsePart(request: QuestionInputRequest, response: InputResponse | undefined): ToolResponsePart;
