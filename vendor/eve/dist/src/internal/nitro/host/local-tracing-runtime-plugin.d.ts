export default function installLocalTracingRuntimePlugin(nitroApp?: {
    readonly hooks?: {
        hook(name: "close", handler: () => Promise<void>): unknown;
    };
}): void;
