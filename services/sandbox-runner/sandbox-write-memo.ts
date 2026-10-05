/**
 * Per container-generation memory of what the runner already wrote into a sandbox.
 *
 * Exports:
 * - `isSkillPackagePath`: the derived, framework-owned files this memo is allowed to skip.
 * - `createSandboxWriteMemo`: skill-file state bound to one container run.
 *
 * Key construct:
 * - Eve rewrites every dynamic skill package on every turn (`dispatchDynamicSkillEvent` has no
 *   diff), which cost 2–5 seconds per Telegram turn in external groups: eleven files, three Docker
 *   operations each. The content of a package never changes inside a session, so the second write
 *   of identical bytes is skipped.
 * - The key carries the container generation (id plus start time), because restricted `$HOME` is a
 *   tmpfs: a restarted container has no skills, and remembering by session alone would leave
 *   `load_skill` failing until the session rotated. A missing generation disables the memo.
 * - Only skill packages qualify. Workspace files are user data: an identical rewrite there must
 *   still reach the container, because nothing else restores a file the model deleted.
 */
import { createHash } from "node:crypto";

const SKILL_PACKAGE_PATH_PATTERN = /(?:^|\/)\.agents\/skills\/|^\/workspace\/skills\//u;
const MAX_REMEMBERED_FILES = 512;

export interface SandboxWriteMemo {
  /** True when this exact content already reached this exact container run. */
  readonly hasSkillFile: (generation: string | null, path: string, content: Uint8Array) => boolean;
  readonly rememberSkillFile: (generation: string | null, path: string, content: Uint8Array) => void;
}

/** Framework-owned skill package files, the only writes the runner may skip. */
export function isSkillPackagePath(path: string): boolean {
  return SKILL_PACKAGE_PATH_PATTERN.test(path);
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createSandboxWriteMemo(): SandboxWriteMemo {
  const skillFiles = new Map<string, string>();

  return {
    hasSkillFile(generation, path, content) {
      if (generation === null || !isSkillPackagePath(path)) return false;
      return skillFiles.get(`${generation}\u0000${path}`) === digest(content);
    },
    rememberSkillFile(generation, path, content) {
      if (generation === null || !isSkillPackagePath(path)) return;
      const key = `${generation}\u0000${path}`;
      skillFiles.delete(key);
      skillFiles.set(key, digest(content));
      // Insertion order is the eviction order; a rotated container never grows the map forever.
      for (const stale of skillFiles.keys()) {
        if (skillFiles.size <= MAX_REMEMBERED_FILES) break;
        skillFiles.delete(stale);
      }
    },
  };
}
