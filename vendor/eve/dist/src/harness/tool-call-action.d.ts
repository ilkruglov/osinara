import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
/** Creates a runtime tool-call action shape from an AI SDK tool call. */
export declare function createRuntimeToolCallActionFromToolCall(input: {
    readonly toolCall: {
        readonly input: unknown;
        readonly toolCallId: string;
        readonly toolName: string;
    };
}): RuntimeToolCallActionRequest;
