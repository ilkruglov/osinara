/**
 * How instrumentation is authored for one agent.
 *
 * `file` is the single `agent/instrumentation.ts` default export. `directory`
 * contains one provider per file, keyed by the slot name the
 * file derives (`instrumentation/otel.ts` → `otel`). Which one an agent may use
 * is decided by `experimental.instrumentationProviders`, never by what happens
 * to be on disk.
 */
export type InstrumentationLayout = {
    readonly kind: "file";
    readonly modulePath: string;
} | {
    readonly kind: "directory";
    readonly modulePathsBySlot: Readonly<Record<string, string>>;
};
/**
 * Resolves the instrumentation layout for one agent root.
 *
 * With providers on, an empty directory layout still installs eve's built-in
 * destinations. Throws when the layout on disk is not the one the flag selects:
 * the wrong layout would otherwise be skipped silently, and telemetry that
 * quietly does nothing is the failure this whole surface exists to prevent.
 */
export declare function resolveInstrumentationLayout(input: {
    readonly agentRoot: string;
    readonly providersEnabled: boolean;
}): InstrumentationLayout | undefined;
