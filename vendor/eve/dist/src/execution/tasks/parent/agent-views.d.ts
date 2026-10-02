import type { HarnessSession } from "#harness/types.js";
import { type AgentView } from "#harness/handles/prompt.js";
/** Derives model-visible task-agent availability from authoritative task views. */
export declare function readTaskAgentViews(session: HarnessSession): Promise<readonly AgentView[]>;
/** Appends the changed task-agent projection before the next model call. */
export declare function appendTaskAgentAnnouncement(session: HarnessSession): Promise<HarnessSession>;
