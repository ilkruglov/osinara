import { type BuildHost } from "#cli/commands/build.js";
import { resolveCliApplicationProject } from "#cli/application-root.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "#cli/dev/ui-options.js";
import { type ResolveVerifiedRemoteDevelopmentClient, type RunAcpServer } from "#cli/acp/command.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import type { EvalCliOptions } from "#evals/cli/eval.js";
import { type InvokeCliRuntimeDependencies } from "#cli/invoke/command.js";
import type { DevelopmentServer, DevelopmentServerOptions, ProductionServerHandle } from "#internal/nitro/host/types.js";
export { resolveDevUiMode, resolveTuiDisplayOptions };
interface CliLogger {
    error(message: string): void;
    log(message: string): void;
}
interface CliRuntimeDependencies {
    isCodingAgentLaunch(): Promise<boolean>;
    findApplicationRoot(cwd: string): Promise<string | undefined>;
    isActiveDevelopmentServerForApp(input: {
        readonly appRoot: string;
        readonly serverUrl: string;
    }): Promise<boolean>;
    buildHost: BuildHost;
    resolveVerifiedRemoteDevelopmentClient: ResolveVerifiedRemoteDevelopmentClient;
    runAcpServer: RunAcpServer;
    printApplicationInfo(logger: CliLogger, appRoot: string, options?: {
        json?: boolean;
    }): Promise<void>;
    runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void>;
    runInvoke: InvokeCliRuntimeDependencies["runInvoke"];
    runEvalCommand(evalIds: readonly string[], options: EvalCliOptions, logger: CliLogger, appRoot: string): Promise<void>;
    startHost(appRoot: string, options?: DevelopmentServerOptions): DevelopmentServer;
    resolveApplicationProject: typeof resolveCliApplicationProject;
    startProductionHost(appRoot: string, options?: {
        host?: string;
        port?: number;
    }): Promise<ProductionServerHandle>;
}
type CliRuntimeOverrides = Partial<CliRuntimeDependencies>;
/** Runs the eve CLI entrypoint. */
export declare function runCli(argv?: string[], logger?: CliLogger, runtime?: CliRuntimeOverrides): Promise<void>;
