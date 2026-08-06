/**
 * Safe replacement for Eve's inherited generic subagent.
 *
 * Export:
 * - `genericSubagentDenialTool`: preserves the built-in name while rejecting shared-sandbox copies.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";

export const genericSubagentDenialTool = defineTool({
  description:
    "Generic shared-sandbox delegation is disabled. Use task_worker for large isolated analysis, transformation, and document-preparation tasks.",
  inputSchema: z.object({
    message: z.string(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  async execute() {
    throw new AppError(
      "AGENT_GENERIC_SUBAGENT_FORBIDDEN",
      "Общая дочерняя сессия отключена. Используйте изолированный task_worker",
    );
  },
});
