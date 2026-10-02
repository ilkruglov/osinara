import type { ModelMessage } from "ai";
import type { AgentHandle, AgentHandleStore } from "#harness/handles/store.js";
/**
 * Label prefixing every framework-injected agents announcement. Mock model
 * adapters use it to treat announcements as transparent scaffolding rather
 * than authored user input.
 */
export declare const AGENTS_SNIPPET_LABEL = "[Agents]";
/** Model-safe projection of one persistent task-mode agent. */
export interface AgentView {
    readonly availability: "available" | "busy";
    readonly id: string;
    readonly name: string;
    readonly statusLine?: string;
    readonly taskId?: string;
    readonly taskStatus?: "working" | "input_required";
}
/** Returns the resumable handles: the only phase the model may continue. */
export declare function projectParkedAgentHandles(store: AgentHandleStore): readonly Extract<AgentHandle, {
    phase: "parked";
}>[];
/**
 * Renders the model-visible agent listing. Only parked handles appear:
 * starting and running children cannot accept a continuation, and private
 * delivery coordinates never render.
 */
export declare function renderAgentsSnippet(store: AgentHandleStore): string;
/** Renders task-derived availability without exposing private addresses. */
export declare function renderAgentViewsSnippet(views: readonly AgentView[]): string;
/**
 * Returns an append-only announcement when the visible handle listing
 * changed since the last one in history, or `undefined` when it is
 * unchanged.
 *
 * The announcement is framework-injected `user`-role conversation content
 * (the pattern system-reminder notes use in Claude Code and OpenCode), not
 * an `assistant` or `system` entry:
 *
 * - `assistant` breaks providers that reject assistant-final requests
 *   (a settle resume carries no new user input, so the announcement would
 *   end the request) and invites the model to imitate the listing.
 * - `system` busts the provider prompt cache for the entire conversation
 *   every time a child settles; append-only history preserves the prefix.
 *
 * The static agent-messaging prompt block declares the `[Agents]` label as
 * eve-injected so the model does not attribute it to the user.
 */
export declare function resolveAgentsAnnouncement(input: {
    readonly agentViews?: readonly AgentView[];
    readonly messages: readonly ModelMessage[];
    readonly store: AgentHandleStore | undefined;
}): string | undefined;
