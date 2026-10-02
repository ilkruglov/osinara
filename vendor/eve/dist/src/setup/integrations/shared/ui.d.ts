import type { Asker } from "../../ask.js";
import type { Prompter } from "../../prompter.js";
import type { SetupApplyContext, SetupExternalAction, SetupPrepareContext, SetupPresenter } from "../types.js";
export declare function createSetupPresenter(prompter: Prompter, beginExternalAction?: (input: {
    url: string;
    userCode?: string;
    message: string;
}) => SetupExternalAction): SetupPresenter;
export declare function createSetupContexts(input: {
    appRoot: string;
    asker: Asker;
    environment: SetupPrepareContext["environment"];
    prompter: Prompter;
    resolveVercelProject: SetupPrepareContext["resolveVercelProject"];
    signal?: AbortSignal;
    force?: boolean;
    beginExternalAction?: (input: {
        url: string;
        userCode?: string;
        message: string;
    }) => SetupExternalAction;
}): {
    prepare: SetupPrepareContext;
    apply: SetupApplyContext;
};
