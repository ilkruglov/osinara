import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import { formatConnectionsSection } from "#runtime/prompt/connections.js";
function composeRuntimeBasePrompt(e) {
  return [
    ...createInstructionsPromptBlocks(e.instructions),
    ...createWorkspacePromptBlocks(e.workspaceSpec),
    ...(e.toolsAvailable
      ? [
          `Tool execution
A single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, eve treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.`,
        ]
      : []),
    ...(e.subagentsAvailable && e.persistentSubagentSessions
      ? [
          e.tasksEnabled
            ? "Agent messaging\nSubagent calls start durable background tasks and return immediately with a task receipt. After delegating, continue helping the user or end your turn; do not wait with task_sleep unless the user explicitly asks you to wait or the task result is required before you can answer. The task will notify you when it completes, fails, needs input, or sends an update; completion and failure notifications include the task's result. Agents you have already delegated to remain visible in the framework-authored `<agents>` conversation note. `availability=busy` means the listed task still owns that agent session: wait for its notification or use task_cancel with its taskId instead of starting a continuation. `availability=available` means no nonterminal task owns the session, so you may pass agentId to the original subagent tool to continue it. Calling a subagent without agentId always starts a new agent session."
            : "Agent messaging\nAgents you have already delegated to stay available after they answer. eve injects the current `<agents>` list into the conversation as a note labeled `[Agents]`; it is added automatically by the framework, not written by the user, and never requires a reply. The list is only a record of those existing agents — their `agentId`, name, and latest status. It does not limit which subagent tools you can call: your tool list is the source of truth, and any subagent tool can always be called without `agentId` to start a new agent, including when the `<agents>` list is empty or absent. Pass `agentId` to the same subagent tool only to continue one of those existing agents' sessions.",
        ]
      : []),
    ...createConnectionsPromptBlocks(e.connections),
    ...createSkillsPromptBlocks(e.skills),
  ];
}
function createInstructionsPromptBlocks(e) {
  let t = (e ?? []).filter(
    (e) => e.role === `system` && e.content.trim().length > 0,
  );
  if (t.length === 0) return [];
  let n = t.length === 1 ? t[0] : void 0;
  return [
    `Instructions (${n !== void 0 && !n.sourceId.startsWith(`ext:`) && !n.sourceId.startsWith(`ext-override:`) ? n.name : `instructions`})\n${t
      .map((e) => e.content)
      .join(
        `

`,
      )
      .trim()}`,
  ];
}
function createWorkspacePromptBlocks(e) {
  if (e === void 0) return [];
  let n = createWorkspacePromptSection(e);
  return n === void 0 ? [] : [n];
}
function createConnectionsPromptBlocks(e) {
  return !e || e.length === 0 ? [] : [formatConnectionsSection(e)];
}
function createSkillsPromptBlocks(t) {
  if (!t || t.length === 0) return [];
  let n = formatAvailableSkillsSection(t);
  return n === null ? [] : [n];
}
export { composeRuntimeBasePrompt };
