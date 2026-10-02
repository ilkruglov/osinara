import { type AgentSourceManifest, type LocalSubagentSourceRef, type ResolvedExtensionMount } from "#discover/manifest.js";
import type { CompiledChannelEntry, CompiledConnectionDefinition, CompiledDynamicInstructionsDefinition, CompiledDynamicSkillDefinition, CompiledDynamicToolDefinition, CompiledHookDefinition, CompiledInstructionsDefinition, CompiledScheduleDefinition, CompiledSkillDefinition, CompiledToolDefinition } from "#compiler/manifest.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
/**
 * Contributions one mounted extension composes into the consuming agent,
 * already namespaced by the mount and rebased onto the consumer's agent root.
 */
export interface CompiledExtensionContributions {
    readonly channels: CompiledChannelEntry[];
    readonly tools: CompiledToolDefinition[];
    readonly dynamicTools: CompiledDynamicToolDefinition[];
    readonly hooks: CompiledHookDefinition[];
    readonly skills: CompiledSkillDefinition[];
    readonly dynamicSkills: CompiledDynamicSkillDefinition[];
    readonly dynamicInstructions: CompiledDynamicInstructionsDefinition[];
    readonly connections: CompiledConnectionDefinition[];
    readonly instructions: CompiledInstructionsDefinition[];
    readonly schedules: CompiledScheduleDefinition[];
}
/**
 * Compiles one mounted extension's source tree and namespaces its
 * contributions by the mount name. Module-backed contributions keep loading
 * from the extension package because their `logicalPath` is rebased to a
 * consumer-relative path — the module-map codegen resolves it against the
 * consumer's agent root, reaching into the extension package unchanged.
 *
 * When the mount was authored as a directory (`extensions/<ns>/`), any
 * consumer-authored override slots are composed under the same namespace and
 * win on name collision: an override tool `<ns>__search` shadows the
 * extension's own `<ns>__search`.
 */
export declare function compileExtensionContributions(input: {
    readonly mount: ResolvedExtensionMount;
    readonly context: ManifestCompileContext;
    readonly consumerAgentRoot: string;
    readonly externalDependencies: readonly string[];
}): Promise<CompiledExtensionContributions>;
/** Composes one mount's root-visible subagents under its namespace. */
export declare function composeExtensionSubagentSources(input: {
    readonly consumerAgentRoot: string;
    readonly mount: ResolvedExtensionMount;
}): LocalSubagentSourceRef[];
/** Returns authored and mounted-extension subagents visible from one agent node. */
export declare function composeAgentSubagentSources(manifest: AgentSourceManifest): LocalSubagentSourceRef[];
/** Earlier entries win, matching directory-override precedence for other slots. */
export declare function mergeExtensionSubagentSources(primary: readonly LocalSubagentSourceRef[], secondary: readonly LocalSubagentSourceRef[]): LocalSubagentSourceRef[];
export interface DisabledToolTarget {
    /** Namespaced target, e.g. `crm__search`. */
    readonly name: string;
    /** Override-relative authored path, e.g. `tools/search.ts`, for diagnostics. */
    readonly logicalPath: string;
}
/**
 * Removes the extension tools an override slot opted out of with `disableTool()`.
 * A `disableTool()` targets a slot by name, so it removes the extension's
 * same-named static tool or dynamic resolver — whichever kind occupies the slot.
 * A disable that matches neither throws rather than silently disabling nothing.
 *
 * Exported for unit testing.
 */
export declare function applyOverrideDisables(input: {
    readonly merged: CompiledExtensionContributions;
    readonly disables: readonly DisabledToolTarget[];
    readonly extensionToolNames: ReadonlySet<string>;
    readonly extensionDynamicToolSlugs: ReadonlySet<string>;
    readonly namespace: string;
}): CompiledExtensionContributions;
/**
 * Merges two composed contribution sets with earlier-set-wins precedence per
 * composed name. Named contributions dedup by their composed identifier so
 * an override shadows the extension's same-named entry. Channel entries dedup
 * as a group so every route from the winning channel is preserved. Unnamed
 * contributions (hooks, dynamic skills, dynamic instructions, static
 * instructions) simply concatenate.
 *
 * Exported for unit testing: passing the consumer overrides as `primary` and
 * the extension's own contributions as `secondary` yields consumer-wins
 * shadowing on name collision.
 */
export declare function mergeContributions(primary: CompiledExtensionContributions, secondary: CompiledExtensionContributions): CompiledExtensionContributions;
