import { Client, type AgentInfoResult, type ClientOptions } from "#client/index.js";
import { type RemoteAuthFlow } from "#cli/dev/tui/remote-auth.js";
import type { Prompter } from "#setup/prompter.js";
import { resolveVerifiedRemoteDevelopmentClient, type VerifiedRemoteDevelopmentClient } from "#setup/verified-remote-client.js";
/** Result of inspecting an authenticated remote eve agent. */
export interface VerifiedRemoteAgentInspection {
    readonly info: AgentInfoResult;
    /** Verified Vercel scope to retain when reconnecting to the same deployment. */
    readonly vercelScope?: string;
}
/** @internal Dependencies for testing verified remote inspection. */
export interface InspectVerifiedRemoteAgentDeps {
    readonly createClient: (options: ClientOptions) => Pick<Client, "info">;
    readonly resolveVerifiedRemoteDevelopmentClient: (input: Parameters<typeof resolveVerifiedRemoteDevelopmentClient>[0]) => Promise<VerifiedRemoteDevelopmentClient>;
    readonly runRemoteAuthFlow: RemoteAuthFlow;
}
/**
 * Inspects a remote eve agent using the same exact-origin credential boundary
 * as remote development clients. When a verified Vercel target needs login or
 * Trusted Sources configuration, an optional prompter completes that flow
 * before inspection is retried.
 */
export declare function inspectVerifiedRemoteAgent(input: {
    readonly serverUrl: string;
    readonly workspaceRoot: string;
    readonly prompter?: Prompter;
    readonly signal?: AbortSignal;
    /** @internal Test seam. */
    readonly deps?: Partial<InspectVerifiedRemoteAgentDeps>;
}): Promise<VerifiedRemoteAgentInspection>;
