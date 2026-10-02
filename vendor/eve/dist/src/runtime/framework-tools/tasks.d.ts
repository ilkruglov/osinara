import { z } from "#compiled/zod/index.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
/**
 * Framework task tools for `experimental.tasks`.
 *
 * With the flag on, subagent calls return a task receipt instead of
 * blocking the parent turn; these tools coordinate that delegated work.
 * `task_cancel` and `task_update` are
 * execute-less runtime actions — they need durable session state and
 * world access, so the runtime-action dispatch step executes them.
 * `task_sleep` only records a durable pause and executes in-loop.
 */
export declare const TASK_CANCEL_TOOL_NAME = "task_cancel";
export declare const TASK_SLEEP_TOOL_NAME = "task_sleep";
export declare const TASK_UPDATE_TOOL_NAME = "task_update";
/** Every model-visible task tool name, for gating and dispatch matching. */
export declare const TASK_TOOL_NAMES: ReadonlySet<string>;
/** Task-control tools executed by the runtime-action dispatch step. */
export declare const TASK_CONTROL_TOOL_NAMES: ReadonlySet<string>;
export declare const TASK_CANCEL_INPUT_SCHEMA: z.ZodObject<{
    taskIds: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const TASK_UPDATE_INPUT_SCHEMA: z.ZodObject<{
    message: z.ZodString;
}, z.core.$strict>;
export declare const TASK_SLEEP_INPUT_SCHEMA: z.ZodObject<{
    seconds: z.ZodNumber;
}, z.core.$strict>;
export declare const TASK_VIEWS_OUTPUT_SCHEMA: z.ZodObject<{
    tasks: z.ZodArray<z.ZodObject<{
        inputRequests: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
        lastOutput: z.ZodOptional<z.ZodObject<{
            data: z.ZodUnknown;
            type: z.ZodEnum<{
                error: "error";
                result: "result";
            }>;
        }, z.core.$strip>>;
        metadata: z.ZodObject<{
            agentId: z.ZodString;
            kind: z.ZodLiteral<"subagent">;
            mode: z.ZodEnum<{
                local: "local";
                remote: "remote";
            }>;
            name: z.ZodString;
        }, z.core.$strip>;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            completed: "completed";
            failed: "failed";
            input_required: "input_required";
            working: "working";
        }>;
        taskId: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const TASK_SLEEP_OUTPUT_SCHEMA: z.ZodObject<{
    waitedSeconds: z.ZodNumber;
}, z.core.$strict>;
/**
 * Builds the harness definitions injected when the root agent enables
 * `experimental.tasks`. Follows the implicit `agent` tool pattern:
 * inline definitions, no registry entry, session-shape hiding in
 * advertised-tools, and re-validation at dispatch.
 */
export declare function createTaskToolHarnessDefinitions(): readonly HarnessToolDefinition[];
/**
 * Whether one node's sessions receive the task tools.
 *
 * Mirrors `isImplicitAgentToolAvailable`: the compile step already
 * rejects `experimental.tasks` on subagents, authored tools with the
 * same name shadow the framework tool, and `disableTool(name)` removes
 * individual tools. Root-node self-delegated children share this node's
 * config, so advertised-tools uses caller/session shape to expose only
 * `task_update` to delegated task children.
 */
export declare function isTaskToolAvailable(input: {
    readonly disabledFrameworkTools: readonly string[];
    readonly hasAuthoredTool: boolean;
    readonly tasksEnabled: boolean;
    readonly toolName: string;
}): boolean;
/**
 * Registry-shaped metadata for the task tools. Not registered in the
 * tool registry (the harness injects the real definitions per node);
 * these entries exist so `disableTool(name)` validates the names.
 */
export declare const TASK_TOOL_DEFINITIONS: readonly ResolvedToolDefinition[];
