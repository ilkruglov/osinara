import type { RuntimeAgentHandleAction } from "#execution/agent-handle-dispatch.js";
/** Resolves the persistent agent identity attached to one delegated task. */
export declare function describeTaskAgent(input: {
    readonly action: RuntimeAgentHandleAction;
    readonly agentId?: string;
    readonly parentSessionId: string;
    readonly parentTurnId: string;
}): {
    readonly agentId: string;
    readonly callId: string;
    readonly mode: "local" | "remote";
    readonly name: string;
};
