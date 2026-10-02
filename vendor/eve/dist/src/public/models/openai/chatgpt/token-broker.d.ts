import { type CodexAppServer, type CodexAppServerOptions } from "./codex-app-server.js";
export type ChatGptAuthState = {
    readonly kind: "checking";
} | {
    readonly accountLabel?: string;
    readonly kind: "ready";
} | {
    readonly kind: "signed-out";
} | {
    readonly kind: "reauth-required";
} | {
    readonly kind: "unavailable";
    readonly reason: string;
};
export interface ChatGptToken {
    readonly accountId?: string;
    readonly accountLabel?: string;
    readonly expiresAt?: number;
    readonly token: string;
}
export interface CodexTokenBroker {
    getToken(input: {
        readonly reason: "rejected" | "request";
    }): Promise<ChatGptToken>;
    refreshState(): Promise<ChatGptAuthState>;
    state(): ChatGptAuthState;
}
export interface CodexTokenBrokerOptions extends CodexAppServerOptions {
    readonly appServer?: CodexAppServer;
    readonly now?: () => number;
}
export declare function createCodexTokenBroker(options?: CodexTokenBrokerOptions): CodexTokenBroker;
export declare function getDefaultCodexTokenBroker(): CodexTokenBroker;
