import type { CancelSessionResult, ClearResult, ClientRedirectPolicy, CompactResult, ResetResult } from "#client/types.js";
interface SessionControlContext {
    readonly host: string;
    readonly redirect?: ClientRedirectPolicy;
    resolveHeaders(): Promise<Headers>;
}
export declare function cancelClientSession(input: {
    readonly context: SessionControlContext;
    readonly options?: {
        readonly turnId?: string;
    };
    readonly sessionId: string;
}): Promise<CancelSessionResult>;
export declare function clearClientSession(input: {
    readonly context: SessionControlContext;
    readonly sessionId: string;
}): Promise<ClearResult>;
export declare function compactClientSession(input: {
    readonly context: SessionControlContext;
    readonly sessionId: string;
}): Promise<CompactResult>;
export declare function resetClientSession(input: {
    readonly context: SessionControlContext;
    readonly options?: {
        readonly reason?: string;
    };
    readonly sessionId: string;
}): Promise<ResetResult>;
export {};
