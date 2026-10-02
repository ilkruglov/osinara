import { type DeployFlowDeps } from "#setup/flows/deploy.js";
import { type Prompter } from "#setup/prompter.js";
import { type VercelProjectCliOptions } from "./vercel-non-interactive.js";
export interface DeployCliLogger {
    error(message: string): void;
    log(message: string): void;
}
export interface DeployCommandDependencies {
    createPrompter?: () => Prompter;
    hasInteractiveTerminal(): boolean;
    /** Test seam into the flow's detection and box effects. */
    flowDeps?: Partial<DeployFlowDeps>;
}
/**
 * `eve deploy`: deploy the agent to Vercel production. An already-linked
 * project deploys straight away (interactively or not); an unlinked interactive
 * run walks the same team/project pickers as onboarding. A non-interactive
 * caller can name a project to link before deployment. The flow itself is
 * {@link runDeployFlow}, shared with the dev TUI's `/deploy`.
 */
export declare function runDeployCommand(logger: DeployCliLogger, appRoot: string, dependencies?: DeployCommandDependencies, options?: VercelProjectCliOptions & {
    yes?: boolean;
}): Promise<void>;
