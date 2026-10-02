import type { PackageManagerKind } from "../../package-manager.js";
import { type ProcessOutputHandler } from "../process-output.js";
import { type PackageManagerProcessResult } from "./process-result.js";
import type { PackageManagerInstallOptions } from "./types.js";
/** Output routing options for setup-owned package manager commands. */
export interface RunPackageManagerOptions {
    /** Streams raw command output to a parent-owned local renderer. */
    onOutput?: ProcessOutputHandler;
    /** Aborts the package-manager subprocess when setup is interrupted. */
    signal?: AbortSignal;
    /** Retains bounded stdout for a caller that must interpret a command's output. */
    captureStdout?: boolean;
    /** Closes stdin so the child cannot contend with a parent-owned TUI. */
    nonInteractive?: boolean;
}
/** @deprecated Use {@link RunPackageManagerOptions}. */
export type RunPnpmOptions = RunPackageManagerOptions;
/** Runs one package-manager command and returns its complete process evidence. */
export declare function spawnPackageManager(kind: PackageManagerKind, projectRoot: string, args: readonly string[], options?: RunPackageManagerOptions): Promise<PackageManagerProcessResult>;
export interface RunInstallOptions extends RunPackageManagerOptions, PackageManagerInstallOptions {
}
export type PackageManagerInstallResult = {
    kind: "installed";
    result: PackageManagerProcessResult;
} | {
    kind: "workspace-probe-failed";
    result: PackageManagerProcessResult;
} | {
    kind: "workspace-probe-unrecognized";
    result: PackageManagerProcessResult;
};
export declare function packageManagerInstallSucceeded(result: PackageManagerInstallResult): boolean;
/** Returns an actionable explanation when a package-manager command produced no output. */
export declare function packageManagerInstallFailureMessage(result: PackageManagerInstallResult): string | undefined;
/** Installs project dependencies and keeps workspace-probe evidence distinct. */
export declare function runPackageManagerInstall(kind: PackageManagerKind, projectRoot: string, options?: RunInstallOptions): Promise<PackageManagerInstallResult>;
/** The argv that runs the locally installed eve binary's `dev` command. */
export declare function eveDevArguments(kind: PackageManagerKind): readonly string[];
export declare function spawnPnpm(projectRoot: string, args: readonly string[], options?: RunPackageManagerOptions): Promise<PackageManagerProcessResult>;
export declare function runPnpmInstall(projectRoot: string, options?: RunPackageManagerOptions): Promise<PackageManagerInstallResult>;
