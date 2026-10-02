import { createDurableSessionState } from "#execution/durable-session-store.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { createSession } from "#execution/session.js";
import { resolveInheritedTokenLimit } from "#execution/run-session-limits.js";
import { resolveEffectiveAgentRuntimeFromConfig } from "#execution/effective-agent-config.js";
import { TASK_UPDATE_SESSION_INSTRUCTION } from "#execution/tasks/child/instructions.js";
import {
  TASK_UPDATE_TOOL_NAME,
  isTaskToolAvailable,
} from "#runtime/framework-tools/tasks.js";
async function createSessionStep(t) {
  "use step";
  let n = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: resolveDurableCompiledArtifactsSource(
        t.compiledArtifactsSource,
      ),
      nodeId: t.nodeId,
    }),
    r = resolveEffectiveAgentRuntimeFromConfig(n, t.dynamicSubagentAgentConfig),
    i =
      t.taskOwned === !0 &&
      isTaskToolAvailable({
        disabledFrameworkTools: n.resolvedAgent.disabledFrameworkTools ?? [],
        hasAuthoredTool: r.turnAgent.tools.some(
          (e) => e.name === TASK_UPDATE_TOOL_NAME,
        ),
        tasksEnabled: n.resolvedAgent.config?.experimental?.tasks === !0,
        toolName: TASK_UPDATE_TOOL_NAME,
      });
  return {
    state: createDurableSessionState({
      session: createSession({
        compactionOverrides: { thresholdPercent: r.thresholdPercent },
        continuationToken: t.continuationToken,
        limits: {
          maxInputTokensPerSession: resolveInheritedTokenLimit({
            configured: r.limits?.maxInputTokensPerSession,
            inherited: t.inheritedLimits?.maxInputTokensPerSession,
          }),
          maxOutputTokensPerSession: resolveInheritedTokenLimit({
            configured: r.limits?.maxOutputTokensPerSession,
            inherited: t.inheritedLimits?.maxOutputTokensPerSession,
          }),
        },
        outputSchema: t.outputSchema,
        rootSessionId: t.rootSessionId,
        sessionId: t.sessionId,
        subagentDepth: t.subagentDepth,
        systemPromptAdditions: i ? [TASK_UPDATE_SESSION_INSTRUCTION] : void 0,
        turnAgent: r.turnAgent,
        workflowMaxSubagents: n.resolvedAgent.workflowTool?.maxSubagents,
      }),
    }),
  };
}
export { createSessionStep };
