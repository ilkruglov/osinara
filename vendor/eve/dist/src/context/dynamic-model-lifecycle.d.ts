import type { ModelMessage } from "ai";
import type { AlsContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import { type LiveDynamicModelSelection } from "#context/keys.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeDynamicModelReference } from "#runtime/agent/bootstrap.js";
import { type RuntimeModelResolutionScope } from "#runtime/agent/resolve-model.js";
export type ActiveDynamicModelSelection = LiveDynamicModelSelection;
export declare class DynamicModelSelectionError extends Error {
    readonly code = "EVE_DYNAMIC_MODEL_SELECTION_FAILED";
    readonly name = "DynamicModelSelectionError";
    constructor(error: unknown);
}
export declare function isDynamicModelSelectionError(error: unknown): error is DynamicModelSelectionError;
export declare function getActiveDynamicModelSelection(ctx: {
    get<T>(key: ContextKey<T>): T | undefined;
}): ActiveDynamicModelSelection | null;
export declare function dispatchDynamicModelEvent(input: {
    readonly ctx: AlsContext;
    readonly dynamicModel: RuntimeDynamicModelReference | undefined;
    readonly event: UnstampedMessageStreamEvent;
    readonly messages: readonly ModelMessage[];
    readonly scope: RuntimeModelResolutionScope;
}): Promise<void>;
