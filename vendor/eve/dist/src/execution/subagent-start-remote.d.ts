import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { resolveRemoteAgentForAction, startRemoteAgentSession } from "#execution/remote-agent-dispatch.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
/** Starts one remote subagent after dispatch planning has selected its target. */
export declare function startRemoteSubagent(input: {
    readonly action: RuntimeRemoteAgentCallActionRequest;
    readonly auth: Parameters<typeof startRemoteAgentSession>[0]["auth"];
    readonly batchEvent: {
        readonly sequence: number;
        readonly turnId: string;
    };
    readonly bundle: CompiledBundle;
    readonly callbackBaseUrl: string | undefined;
    readonly currentSession: RuntimeSession;
    readonly dynamicRemoteAgent?: NonNullable<Parameters<typeof resolveRemoteAgentForAction>[0]["dynamicRemoteAgent"]>;
    readonly initiatorAuth: Parameters<typeof startRemoteAgentSession>[0]["initiatorAuth"];
    readonly parentContinuationToken: string | undefined;
    readonly parentTraceContext: Parameters<typeof startRemoteAgentSession>[0]["parentTraceContext"];
    readonly persistentSessions: boolean;
    readonly session: RuntimeSession;
    readonly taskOwned: boolean;
}): Promise<DispatchOutcome>;
