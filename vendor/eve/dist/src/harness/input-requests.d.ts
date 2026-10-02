import type { ModelMessage } from "ai";
import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { InputRequest } from "#runtime/input/types.js";
import { getApprovedTools } from "#harness/hitl/approval-input-requests.js";
import type { RejectedActionBatch } from "#harness/hitl/approval-input-requests.js";
import type { ResolvePendingInputResult } from "#harness/hitl/pending-input-resolution.js";
import { clearPendingSessionLimitPrompt } from "#harness/hitl/session-limit-input-requests.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
export { getApprovedTools, clearPendingSessionLimitPrompt };
export type { RejectedActionBatch };
export type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
export { appendPendingInputBatch, consumeDeferredStepInput, getPendingInputRequestIds, hasDeferredStepInput, hasPendingInputBatch, } from "#harness/pending-input-batches.js";
/** Returns true when the step input carries user-facing turn input. */
export declare function hasStepInput(input?: StepInput): boolean;
/** Returns true when any pending batch still contains a tool approval. */
export declare function hasPendingApprovalBatch(session: HarnessSession): boolean;
/**
 * Resolves pending input at the start of a harness step.
 *
 * Ordered batches remain independently answerable. Session-limit prompts own
 * resolution while open; approval batches preserve AI SDK's tail-message
 * requirement; question-only batches retain dismiss-and-continue behavior.
 */
export declare function resolvePendingInput(input: {
    readonly deferMessagesWhileApprovalsPending?: boolean;
    readonly history?: readonly ModelMessage[];
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
    readonly session: HarnessSession;
    readonly stepInput?: StepInput;
}): ResolvePendingInputResult;
/** Creates a runtime tool-call action shape from an AI SDK tool call. */
export declare function createRuntimeToolCallActionFromToolCall(input: {
    readonly toolCall: {
        readonly input: unknown;
        readonly toolCallId: string;
        readonly toolName: string;
    };
}): RuntimeToolCallActionRequest;
