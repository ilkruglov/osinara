import { type ChildProcessWithoutNullStreams } from "node:child_process";
export interface CodexAuthStatus {
    readonly authMethod?: string;
    readonly authToken?: string;
    readonly requiresOpenaiAuth?: boolean;
}
export interface CodexAppServer {
    getAuthStatus(input: {
        readonly refreshToken: boolean;
    }): Promise<CodexAuthStatus>;
    restart?(): void;
}
export interface CodexAppServerProcess {
    readonly stderr: ChildProcessWithoutNullStreams["stderr"];
    readonly stdin: ChildProcessWithoutNullStreams["stdin"];
    readonly stdout: ChildProcessWithoutNullStreams["stdout"];
    kill(): boolean;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    unref(): void;
}
type SpawnCodexAppServer = (command: string, args: readonly string[], options: {
    readonly env?: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
}) => CodexAppServerProcess;
export interface CodexAppServerOptions {
    readonly command?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly spawnProcess?: SpawnCodexAppServer;
}
/** Minimal authenticated subset of Codex's JSONL app-server protocol. */
export declare class CodexAppServerClient implements CodexAppServer {
    #private;
    constructor(options?: CodexAppServerOptions);
    getAuthStatus(input: {
        readonly refreshToken: boolean;
    }): Promise<CodexAuthStatus>;
    restart(): void;
}
export {};
