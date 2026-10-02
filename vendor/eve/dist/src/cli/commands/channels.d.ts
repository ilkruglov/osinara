import type { ResolvedDiscoveryProject } from "#discover/project.js";
export interface CliLogger {
    error(message: string): void;
    log(message: string): void;
}
export interface ListChannelsCommandOptions {
    json?: boolean;
}
export declare function runChannelsListCommand(logger: CliLogger, project: ResolvedDiscoveryProject, options: ListChannelsCommandOptions): Promise<void>;
