/**
 * VM engine selection for workflow execution.
 *
 * The Node.js `node:vm` engine is the default. The QuickJS WASM engine is
 * opt-in via the `WORKFLOW_VM` env var or `executionContext.workflowVm`.
 *
 * Both engines implement the same event-replay execution model: on every
 * workflow handler invocation the workflow function is re-executed from the
 * top and the recorded event log resolves awaited primitives. The QuickJS
 * engine runs the workflow code in a QuickJS WASM VM (via quickjs-wasi)
 * instead of a `node:vm` context, which makes it usable on platforms that
 * do not implement `node:vm` (e.g. Cloudflare Workers) and is the
 * foundation for VM-memory snapshotting.
 */
import type { WorkflowRun } from '#compiled/@workflow/world/index.js';
/**
 * Known workflow VM engines. Any other `WORKFLOW_VM` value is treated as
 * a misconfiguration and rejected at startup.
 */
export declare const WORKFLOW_VMS: readonly ["node", "quickjs"];
export type WorkflowVmMode = (typeof WORKFLOW_VMS)[number];
/**
 * Read and validate the `WORKFLOW_VM` env var.
 *
 * Returns the configured engine, or `undefined` if unset/empty.
 * Throws {@link WorkflowRuntimeError} if the value is set but not one of
 * the known engines — catching misconfiguration early is better than
 * silently falling back to the default.
 */
export declare function getWorkflowVmFromEnv(env?: NodeJS.ProcessEnv): WorkflowVmMode | undefined;
/**
 * Whether to use the QuickJS WASM VM for a given run.
 *
 * The run's `executionContext.workflowVm` (stamped by the SDK at `start()`
 * when `WORKFLOW_VM` is set on the client) takes precedence so a run keeps
 * executing on the engine it started on. When the run doesn't specify an
 * engine, the `WORKFLOW_VM` env var on the workflow handler decides.
 * The default is the `node:vm` engine.
 *
 * Throws if `WORKFLOW_VM` or `executionContext.workflowVm` is set to an
 * unknown value.
 */
export declare function useQuickJSVm(workflowRun: WorkflowRun): boolean;
//# sourceMappingURL=vm-mode.d.ts.map