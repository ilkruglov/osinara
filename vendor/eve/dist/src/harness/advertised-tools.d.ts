import type { ToolSet } from "ai";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { WorkflowSandboxLifecycle } from "#shared/workflow-sandbox.js";
type AdvertisedToolSession = Pick<HarnessSession, "rootSessionId" | "subagentDepth">;
type AdvertisedToolMapInput = {
    readonly delegatedCaller?: boolean;
    readonly session: AdvertisedToolSession;
    readonly tools: HarnessToolMap;
};
type AdvertisedToolDefinitionsInput = {
    readonly delegatedCaller?: boolean;
    readonly session: AdvertisedToolSession;
    readonly tools: readonly HarnessToolDefinition[];
};
type AdvertisedModelToolsInput = {
    readonly delegatedCaller?: boolean;
    readonly modelTools: ToolSet;
    readonly session: HarnessSession;
    readonly tools: HarnessToolMap;
    readonly workflow?: {
        readonly lifecycle?: (input: {
            readonly session: HarnessSession;
            readonly tools: HarnessToolMap;
        }) => WorkflowSandboxLifecycle | undefined;
        readonly maxSubagents?: number;
    };
};
type AdvertisedModelTools = {
    readonly harnessTools: HarnessToolMap;
    readonly modelTools: ToolSet;
    readonly session: HarnessSession;
};
export declare function getAdvertisedTools(input: AdvertisedModelToolsInput): Promise<AdvertisedModelTools>;
export declare function getAdvertisedTools(input: AdvertisedToolMapInput): HarnessToolMap;
export declare function getAdvertisedTools(input: AdvertisedToolDefinitionsInput): readonly HarnessToolDefinition[];
export {};
