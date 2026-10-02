import type { ContextContainer } from "#context/container.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
/**
 * Forwards one task child's blocking transition to its parent's session
 * callback.
 *
 * Task children report HITL and authorization transitions exclusively to the
 * parent's task run, so the run can block/unblock the task under one durable
 * decision and only the parent channel owns the interaction. Returns whether
 * the event was forwarded and must therefore be suppressed locally.
 */
export declare function forwardTaskEventToSessionCallback(ctx: ContextContainer, event: UnstampedMessageStreamEvent): Promise<boolean>;
