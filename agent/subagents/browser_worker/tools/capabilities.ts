/**
 * Tool surface of the browser worker: the browser and the eyes, nothing else.
 *
 * Constructs:
 * - Eve registers its built-ins for every agent node and 0.40.0 cannot hide them, so the ones the
 *   worker must not reach are overridden with explicit denials, as external groups do.
 * - `browser_confirm` is absent: the click a person has to approve is performed by the root agent,
 *   where the person is asked.
 * - The worker tool exists in every mode (a declared subagent cannot be hidden or overridden by
 *   name), so the surface itself is the boundary: outside a private chat or family group, or in
 *   the memory review, every tool here is a refusal, `inspect_workspace_image` included, which
 *   would otherwise bypass the external allowlist wrapper of the root surface.
 * - The step budget (`BROWSER_WORKER_MAX_MODEL_STEPS`) is enforced here, fail-closed: Eve allows a
 *   declared subagent no dynamic model, so past the budget, or on a malformed step event, the
 *   browser tools become refusals that tell the worker to return its result.
 */
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { BROWSER_WORKER_MAX_MODEL_STEPS } from "../../../config.js";
import { AppError } from "../../../lib/app-error.js";
import browserAct from "../../../lib/tools/browser_act.js";
import browserLook from "../../../lib/tools/browser_look.js";
import browserOpen from "../../../lib/tools/browser_open.js";
import browserRead from "../../../lib/tools/browser_read.js";
import browserSession from "../../../lib/tools/browser_session.js";
import inspectWorkspaceImage from "../../../lib/tools/inspect_workspace_image.js";
import { readModelStepIndex } from "../../../lib/turn-model-step-limit.js";

export const BROWSER_WORKER_DENIED_TOOL_NAMES = [
  "ask_question", "bash", "glob", "grep", "load_skill", "read_file", "todo", "web_fetch", "web_search", "write_file",
] as const;

function deniedTool(name: string) {
  return defineTool({
    description: `Инструмент ${name} недоступен исполнителю задач в браузере.`,
    inputSchema: z.record(z.string(), z.unknown()),
    async execute() {
      throw new AppError("AGENT_BROWSER_WORKER_TOOL_FORBIDDEN", "Исполнителю задач в браузере доступны только инструменты браузера");
    },
  });
}

const BROWSER_WORKER_TOOLS = {
  browser_act: browserAct,
  browser_look: browserLook,
  browser_open: browserOpen,
  browser_read: browserRead,
  browser_session: browserSession,
  inspect_workspace_image: inspectWorkspaceImage,
};

function untrustedTool(name: string) {
  return defineTool({
    description: `Инструмент ${name} недоступен: исполнитель браузера работает только в личном чате и семейной группе.`,
    inputSchema: z.record(z.string(), z.unknown()),
    async execute() {
      throw new AppError("AGENT_BROWSER_FORBIDDEN", "Исполнитель браузера доступен только в личном чате и семейной группе");
    },
  });
}

function exhaustedTool(name: string) {
  return defineTool({
    description: `Инструмент ${name} больше недоступен: лимит шагов исполнителя исчерпан. Верни итог со status=blocked.`,
    inputSchema: z.record(z.string(), z.unknown()),
    async execute() {
      throw new AppError("AGENT_BROWSER_WORKER_STEP_LIMIT_EXCEEDED", "Лимит шагов исполнителя в браузере исчерпан: верни итог со status=blocked и тем, что удалось выяснить");
    },
  });
}

export default defineDynamic({
  events: {
    "step.started": (event, ctx) => {
      const attributes = ctx.session.auth.current?.attributes;
      const trusted = attributes !== undefined && attributes.role !== "external" && attributes.memoryReviewMode === undefined
        && (attributes.telegramChatType === "private" || attributes.groupType === "family_private");
      const step = readModelStepIndex(event);
      const withinBudget = step !== null && step < BROWSER_WORKER_MAX_MODEL_STEPS;
      return {
        ...Object.fromEntries(Object.entries(BROWSER_WORKER_TOOLS).map(([name, tool]) => [name, !trusted ? untrustedTool(name) : withinBudget ? tool : exhaustedTool(name)])),
        ...Object.fromEntries(BROWSER_WORKER_DENIED_TOOL_NAMES.map((name) => [name, deniedTool(name)])),
      };
    },
  },
});
