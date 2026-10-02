import { runVercelEnvPull } from "#setup/run-vercel-link.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { runVercel } from "#setup/primitives/index.js";
export interface VercelNonInteractiveLogger {
    error(message: string): void;
    log(message: string): void;
}
export interface VercelProjectCliOptions {
    nonInteractive?: boolean;
    project?: string;
    team?: string;
}
export interface NonInteractiveLinkDependencies {
    isEveProject: typeof isEveProject;
    runVercel: typeof runVercel;
    runVercelEnvPull: typeof runVercelEnvPull;
}
export declare function isNonInteractiveProjectCommand(options: VercelProjectCliOptions): boolean;
/** Links a named Vercel project and refreshes its local environment without a prompt. */
export declare function runNonInteractiveLink(input: {
    logger: VercelNonInteractiveLogger;
    appRoot: string;
    options: VercelProjectCliOptions;
    dependencies?: NonInteractiveLinkDependencies;
}): Promise<boolean>;
