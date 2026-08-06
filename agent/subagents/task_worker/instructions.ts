/**
 * Isolated universal task worker instructions.
 *
 * Export:
 * - A narrow task contract for research, analysis, and workspace artifact preparation.
 */
import { defineInstructions } from "eve/instructions";

import { SUBAGENT_WORKER_RULES } from "../../lib/prompt/delegation-fragments.js";

export default defineInstructions({
  markdown: SUBAGENT_WORKER_RULES,
});
