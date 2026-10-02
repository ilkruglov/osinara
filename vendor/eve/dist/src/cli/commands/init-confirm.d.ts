import { type Prompter } from "#setup/prompter.js";
export interface InitConfirmDependencies {
    createPrompter(): Prompter;
    hasInteractiveTerminal(): boolean;
}
export type InitNonEmptyDirectoryTarget = {
    kind: "current-directory";
} | {
    kind: "subdirectory";
    name: string;
};
export declare function confirmInitInNonEmptyDirectory(entries: readonly string[], dependencies?: InitConfirmDependencies): Promise<InitNonEmptyDirectoryTarget>;
