/**
 * Whether `browser_task` is offered at all.
 *
 * Export:
 * - `BROWSER_TASK_AVAILABLE`: true only when a Jev key is configured. Kept apart from the tool so
 *   prompt assembly can follow the tool surface without importing the tool's dependencies.
 */
export const BROWSER_TASK_AVAILABLE = (process.env.TYPESAFE_API_KEY?.trim() ?? "").length > 0;
