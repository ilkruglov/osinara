import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { type SetupApplyContext, type SetupPrepareContext } from "../types.js";
import { attachLinearConnector, findLinearConnector, provisionLinearConnector, type LinearConnectorRef } from "./connect.js";
export interface LinearSetupDeps {
    attachConnector: typeof attachLinearConnector;
    deriveConnectorSlug: typeof deriveSlackConnectorSlug;
    findConnector: typeof findLinearConnector;
    provisionConnector: typeof provisionLinearConnector;
    writeTextFile: typeof writeTextFile;
}
export declare function linearSafeConnectorSlug(slug: string): string;
type ConnectorPlan = {
    kind: "reuse";
    connector: LinearConnectorRef;
} | {
    kind: "create";
    slug: string;
};
export interface LinearSetupPlan {
    connector: ConnectorPlan;
    project: VercelProjectReference;
}
export declare function prepareLinearSetup(context: SetupPrepareContext, deps?: LinearSetupDeps): Promise<LinearSetupPlan>;
export declare function applyLinearSetup(plan: LinearSetupPlan, context: SetupApplyContext, deps?: LinearSetupDeps): Promise<{
    facts: never[];
    deploymentRequired: true;
}>;
export declare const LINEAR_SETUP: import("../types.js").SetupIntegration;
export {};
