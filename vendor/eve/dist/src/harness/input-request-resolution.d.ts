import type { PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
export declare const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
type ApprovalTerminalStatus = "approved" | "denied" | "ignored" | "invalid";
export interface ResolvedInputBatch {
    readonly event: PendingInputBatchEvent;
    readonly inputs: readonly {
        readonly outcome: "answered" | ApprovalTerminalStatus;
        readonly request: InputRequest;
        readonly response?: InputResponse;
    }[];
}
export declare function buildResolvedInputBatch(batch: {
    readonly event?: PendingInputBatchEvent;
    readonly requests: readonly InputRequest[];
}, responses: readonly InputResponse[]): ResolvedInputBatch | undefined;
export declare function resolveApprovalOutcome(response: InputResponse | undefined): {
    readonly approved: boolean;
    readonly reason: string | undefined;
    readonly status: ApprovalTerminalStatus;
};
export {};
