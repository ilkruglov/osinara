export type PackageManagerProcessTermination = {
    kind: "exit";
    code: number;
} | {
    kind: "signal";
    signal: string;
} | {
    kind: "aborted";
    reason?: string;
} | {
    kind: "spawn-error";
    code?: string;
    message: string;
};
export interface PackageManagerProcessResult {
    command: {
        executable: string;
        args: readonly string[];
        cwd: string;
    };
    termination: PackageManagerProcessTermination;
    /** Byte-bounded stdout for commands whose caller needs to interpret it. */
    stdout: string;
}
export declare function resultSucceeded(result: PackageManagerProcessResult): boolean;
export interface PackageProcessStdoutCollector {
    end(): void;
    result(termination: PackageManagerProcessTermination): PackageManagerProcessResult;
    write(chunk: Buffer): void;
}
export declare function createPackageProcessStdoutCollector(input: {
    command: PackageManagerProcessResult["command"];
    maxCapturedBytes?: number;
}): PackageProcessStdoutCollector;
