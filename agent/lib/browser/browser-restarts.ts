/**
 * How many times this process restarted the browser of each sandbox session.
 *
 * Exports:
 * - `browserGeneration`: the current count for a sandbox (0 until its first restart).
 * - `noteBrowserRestart`: called by the driver after it killed a hung daemon.
 * - `recordLookGeneration`, `isLookStale`: the generation a saved look was taken under, and whether
 *   a restart closed its page since.
 *
 * Key construct:
 * - A look reads the page, then waits for the vision model; a restart by another tool in between
 *   (Lavka, Yandex Go, another browser call) closes that page. The look compares the generation it
 *   started under before saving, so a look of a closed page is never stored (Codex review,
 *   24 October 2026). Browser calls run in the agent process, so a process-wide count is enough.
 * - Readers of the saved look treat a look older than the last restart as absent. That covers a
 *   look whose save raced a restart (the row came back after the reset deleted it) and a reset whose
 *   DELETE failed. A look saved before this process started has no record and counts as taken under
 *   generation 0, which only a restart in this process moves past.
 */
const MAX_TRACKED_SANDBOXES = 2_000;

const generations = new Map<string, number>();
const lookGenerations = new Map<string, number>();

/** Keeps a bounded map: the oldest sandboxes are dropped first. */
function remember(registry: Map<string, number>, sandboxSessionId: string, value: number): void {
  registry.delete(sandboxSessionId);
  registry.set(sandboxSessionId, value);
  while (registry.size > MAX_TRACKED_SANDBOXES) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

export function browserGeneration(sandboxSessionId: string): number {
  return generations.get(sandboxSessionId) ?? 0;
}

export function noteBrowserRestart(sandboxSessionId: string): void {
  remember(generations, sandboxSessionId, browserGeneration(sandboxSessionId) + 1);
}

export function recordLookGeneration(sandboxSessionId: string, generation: number): void {
  remember(lookGenerations, sandboxSessionId, generation);
}

export function isLookStale(sandboxSessionId: string): boolean {
  return browserGeneration(sandboxSessionId) > (lookGenerations.get(sandboxSessionId) ?? 0);
}
