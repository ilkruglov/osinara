import { detectPackageManager } from "#setup/package-manager.js";
import { ensureChannel } from "#setup/scaffold/index.js";
import { installScaffoldDependencies } from "../shared/scaffold.js";
import { type SetupApplyContext, type SetupPrepareContext } from "../types.js";
export interface WebSetupDeps {
    detectPackageManager: typeof detectPackageManager;
    ensureChannel: typeof ensureChannel;
    installScaffoldDependencies: typeof installScaffoldDependencies;
}
export interface WebSetupPlan {
    configureVercelServices: boolean;
    packageManager: Awaited<ReturnType<typeof detectPackageManager>>["kind"];
}
export declare function prepareWebSetup(context: SetupPrepareContext, deps?: WebSetupDeps): Promise<WebSetupPlan>;
export declare function applyWebSetup(plan: WebSetupPlan, context: SetupApplyContext, deps?: WebSetupDeps): Promise<{
    facts: never[];
    deploymentRequired?: undefined;
} | {
    facts: never[];
    deploymentRequired: true;
}>;
export declare const WEB_SETUP: import("../types.js").SetupIntegration;
