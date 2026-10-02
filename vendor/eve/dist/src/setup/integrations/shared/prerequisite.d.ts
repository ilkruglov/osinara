export type SetupPrerequisite = {
    kind: "command";
    code: string;
    message: string;
    command: string;
} | {
    kind: "environment";
    code: string;
    message: string;
    variable: string;
    sensitive: true;
};
/** A setup blocker whose prerequisite must be satisfied by the caller. */
export declare class SetupPrerequisiteRequired extends Error {
    readonly prerequisite: SetupPrerequisite;
    constructor(prerequisite: SetupPrerequisite);
}
