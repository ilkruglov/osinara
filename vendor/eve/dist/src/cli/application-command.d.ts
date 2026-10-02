import type { Command } from "#compiled/commander/index.js";
import type { ResolvedDiscoveryProject } from "#discover/project.js";
export interface CliApplicationContext {
    root: string;
    project?: ResolvedDiscoveryProject;
    resolve(): Promise<void>;
}
export type CliApplicationRootRequirement = (command: Command) => boolean;
/** Adds application-root resolution to a project-scoped CLI command. */
export declare function applicationCommand(command: Command, applicationContext: CliApplicationContext, requirement?: CliApplicationRootRequirement): Command;
