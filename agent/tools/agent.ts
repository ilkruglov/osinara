/**
 * Generic Eve subagent replacement.
 *
 * Export:
 * - An authored denial tool which takes priority over the child that would inherit root state.
 */
import { genericSubagentDenialTool } from "../lib/tool-policy/generic-subagent-denial.js";

export default genericSubagentDenialTool;
