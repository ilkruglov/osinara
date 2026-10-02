import { type DurableSessionState } from "#execution/durable-session-store.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
/** Dispatches the child-agent action currently blocking a dynamic workflow. */
export declare function dispatchWorkflowRuntimeActionsStep(input: {
    readonly callbackBaseUrl?: string;
    readonly parentContinuationToken?: string;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}): Promise<{
    readonly results: readonly RuntimeActionResult[];
    readonly sessionState: DurableSessionState;
    readonly pendingTasks: readonly {
        readonly taskInboxToken: string;
        readonly taskId: string;
        readonly taskRunId: string;
    }[];
}>;
