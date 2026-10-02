import type { ContextContainer } from "#context/container.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeIdentity, RuntimeTraceContext } from "#protocol/message.js";
/** Prepares native tracing for workflow-owned preambles emitted outside the tool loop. */
export declare function prepareWorkflowPreambleTrace(input: {
    readonly ctx: ContextContainer;
    readonly emissionState: HarnessEmissionState;
    readonly runtimeIdentity: RuntimeIdentity;
    readonly session: HarnessSession;
}): Promise<RuntimeTraceContext | undefined>;
