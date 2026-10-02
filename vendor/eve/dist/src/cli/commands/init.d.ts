import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { detectInvokingPackageManager, detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall, spawnPackageManager } from "#setup/primitives/index.js";
import { addAgentToProject } from "#setup/scaffold/create/add-to-project.js";
import { ensureChannel, scaffoldBaseProject } from "#setup/scaffold/index.js";
import { validateModelSlug } from "#setup/flows/model-source-change.js";
import { confirmInitInNonEmptyDirectory } from "./init-confirm.js";
import { tryInitializeGit } from "./init-git.js";
import { selectInitHandoff, spawnCodingAgentRepl } from "./init-repl.js";
export interface InitCliLogger {
    error(message: string): void;
    log(message: string): void;
}
export interface InitCommandOptions {
    /** Add the Web Chat channel (a Next.js app). Set by `--channel-web-nextjs`. */
    channelWebNextjs?: boolean;
    /** Model id written to the root agent config. Set by `--model`. */
    model?: string;
    /** Reasoning effort written to the root agent config. Set by `--reasoning`. */
    reasoning?: AgentReasoningDefinition;
}
export interface InitCommandDependencies {
    addAgentToProject: typeof addAgentToProject;
    confirmInitInNonEmptyDirectory: typeof confirmInitInNonEmptyDirectory;
    detectInvokingPackageManager: typeof detectInvokingPackageManager;
    detectPackageManager: typeof detectPackageManager;
    ensureChannel: typeof ensureChannel;
    isCodingAgentLaunch: typeof isCodingAgentLaunch;
    now: () => number;
    runPackageManagerInstall: typeof runPackageManagerInstall;
    scaffoldBaseProject: typeof scaffoldBaseProject;
    selectInitHandoff: typeof selectInitHandoff;
    spawnCodingAgentRepl: typeof spawnCodingAgentRepl;
    spawnPackageManager: typeof spawnPackageManager;
    tryInitializeGit: typeof tryInitializeGit;
    validateModelSlug: typeof validateModelSlug;
}
export declare const EVE_INIT_PACKAGE_SPEC_ENV = "EVE_INIT_PACKAGE_SPEC";
/**
 * Creates a new eve agent (`target` is a project name), or adds one to an
 * existing project (`target` is a directory), without external provisioning.
 * A fresh in-place scaffold asks whether to use the current directory or a new
 * subdirectory when the current directory is not empty. Coding-agent launches
 * must pass an explicit subdirectory instead.
 *
 * Runs launched by a coding agent get the dev command printed instead of
 * spawned after scaffolding, since the dev TUI would wedge the launching agent.
 *
 * For extension packages, use `eve extension init` instead.
 */
export declare function runInitCommand(logger: InitCliLogger, parentDirectory: string, target: string | undefined, options: InitCommandOptions, dependencies?: InitCommandDependencies): Promise<void>;
