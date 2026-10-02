import type { UserContent } from "ai";
import type { SessionAuthContext } from "#channel/types.js";
import { type ChannelFrom } from "#channel/channel-operations.js";
import type { AgentInvocation, AgentInvocationMutationResult } from "#internal/invocation/agent-invocation.js";
import type { RouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";
export declare class WorkflowAgentInvocationExecution {
    #private;
    constructor(input: {
        readonly createSession: RouteSessionCreator;
        readonly from: ChannelFrom;
    });
    create(input: {
        readonly auth: SessionAuthContext | null;
        readonly message: string | UserContent;
        readonly outputSchema?: JsonObject;
    }): Promise<AgentInvocation>;
    read(input: {
        readonly auth: SessionAuthContext | null;
        readonly invocationId: string;
    }): Promise<AgentInvocation | undefined>;
    update(input: {
        readonly auth: SessionAuthContext | null;
        readonly invocationId: string;
        readonly responses: readonly InputResponse[];
    }): Promise<AgentInvocationMutationResult>;
    cancel(input: {
        readonly auth: SessionAuthContext | null;
        readonly invocationId: string;
    }): Promise<AgentInvocation | undefined>;
}
