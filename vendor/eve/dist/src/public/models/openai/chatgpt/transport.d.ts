import { type CodexTokenBroker } from "./token-broker.js";
type Fetch = typeof globalThis.fetch;
export interface CodexTransportOptions {
    readonly broker?: CodexTokenBroker;
    readonly codexApiEndpoint?: string;
    readonly fetch?: Fetch;
}
/**
 * Routes OpenAI Responses requests through the Codex backend. Authentication is
 * resolved by the Codex CLI; eve never reads, refreshes, or persists OAuth
 * credentials itself.
 */
export declare function createCodexFetch(options?: CodexTransportOptions): Fetch;
export declare function rewriteCodexEndpoint(input: string, codexApiEndpoint?: string): string;
export {};
