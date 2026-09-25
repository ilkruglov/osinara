/**
 * Tool surface of the browser worker: the browser and the eyes, nothing else.
 *
 * Constructs:
 * - Eve registers its built-ins for every agent node and 0.40.0 cannot hide them, so the ones the
 *   worker must not reach are overridden with explicit denials, as external groups do.
 * - `browser_confirm` is absent: the click a person has to approve is performed by the root agent,
 *   where the person is asked.
 */
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../../../lib/app-error.js";
import browserAct from "../../../lib/tools/browser_act.js";
import browserLook from "../../../lib/tools/browser_look.js";
import browserOpen from "../../../lib/tools/browser_open.js";
import browserRead from "../../../lib/tools/browser_read.js";
import browserSession from "../../../lib/tools/browser_session.js";
import inspectWorkspaceImage from "../../../lib/tools/inspect_workspace_image.js";

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

export default defineDynamic({
  events: {
    "step.started": () => ({
      browser_act: browserAct,
      browser_look: browserLook,
      browser_open: browserOpen,
      browser_read: browserRead,
      browser_session: browserSession,
      inspect_workspace_image: inspectWorkspaceImage,
      ...Object.fromEntries(BROWSER_WORKER_DENIED_TOOL_NAMES.map((name) => [name, deniedTool(name)])),
    }),
  },
});
