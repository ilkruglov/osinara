import type { ResolvedConnectionDefinition } from "#runtime/types.js";
/** Resolves and merges application-provided arguments, with application values winning. */
export declare function resolveProvidedArguments(input: {
    readonly args: unknown;
    readonly connection: ResolvedConnectionDefinition;
    readonly toolName: string;
}): Promise<Record<string, unknown>>;
/** Removes application-provided top-level properties from a remote tool schema. */
export declare function omitProvidedArgumentsFromSchema<TSchema extends Record<string, unknown>>(schema: TSchema, names: readonly string[]): TSchema;
