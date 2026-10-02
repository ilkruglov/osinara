import { type LinkFlowDeps } from "#setup/flows/link.js";
import { type Prompter } from "#setup/prompter.js";
import { type VercelProjectCliOptions } from "./vercel-non-interactive.js";
export interface LinkCliLogger {
    error(message: string): void;
    log(message: string): void;
}
export interface LinkCommandDependencies {
    createPrompter?: () => Prompter;
    hasInteractiveTerminal(): boolean;
    /** Test seam into the flow's detection and box effects. */
    flowDeps?: Partial<LinkFlowDeps>;
}
/**
 * `eve link`: pick a Vercel team, then create or select a project (re-linking
 * when one is already linked), run `vercel link` for the resolved project,
 * then pull env so the AI Gateway credential lands in `.env.local`. The flow
 * itself is {@link runLinkFlow}, shared with the dev TUI `/model` menu's
 * provider row. Non-interactive callers name the Vercel project explicitly;
 * interactive callers use the eve-owned pickers.
 */
export declare function runLinkCommand(logger: LinkCliLogger, appRoot: string, dependencies?: LinkCommandDependencies, options?: VercelProjectCliOptions): Promise<void>;
