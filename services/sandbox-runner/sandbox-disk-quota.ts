/**
 * Disk budget of sandbox workspaces, enforced by the runner before the model writes.
 *
 * Exports:
 * - `SANDBOX_WORKSPACE_QUOTA_BYTES`, `SANDBOX_MIN_FREE_BYTES`: the per-workspace budget and the
 *   free space the host keeps for the database and the system.
 * - `SANDBOX_QUOTA_REFUSED_EXIT_CODE`: exit status of a refused command.
 * - `isCleanupCommand`: a command that only frees or inspects space, allowed past the budget.
 * - `createSandboxDiskQuota`: measured usage per workspace, cached, and the refusal text.
 * - `createHostDiskProbe`: `du` and `statfs` on the runner's own volume mounts.
 *
 * Key construct:
 * - The application writer limited single files, but the model's Bash writes straight into the
 *   workspace and tool volumes, which share the host disk with PostgreSQL (security review and
 *   Codex security scan, 5 October 2026). Before a Bash command or a file write the runner checks
 *   the workspace's usage (its files, tool environment and browser state) against 2 GiB and the
 *   host's free space against 3 GiB; past either, writes are refused and only commands that free
 *   space run. Usage is measured with `du` at most once a minute per workspace, so a single
 *   command can still overshoot; the hard ceiling belongs to the filesystem, not to this check.
 */
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";

export const SANDBOX_WORKSPACE_QUOTA_BYTES = 2 * 1024 ** 3;
export const SANDBOX_MIN_FREE_BYTES = 3 * 1024 ** 3;
export const SANDBOX_QUOTA_REFUSED_EXIT_CODE = 125;
const MEASURE_TTL_MS = 60_000;
const MAX_CACHED_WORKSPACES = 2_000;

/**
 * `rm`, `rmdir`, `ls`, `du`, `df` or `find` alone, with no chaining, redirection or substitution:
 * enough to see what takes space and delete it, nothing that writes.
 */
export function isCleanupCommand(command: string): boolean {
  return /^\s*(?:rm|rmdir|ls|du|df|find)(?:\s[^;&|`$<>(){}\n]*)?$/u.test(command);
}

export interface DiskProbe {
  /** Bytes allocated under the directories that exist; missing ones count zero. */
  usedBytes(directories: readonly string[]): Promise<number>;
  freeBytes(): Promise<number>;
}

export interface WorkspaceDirectories {
  key: string;
  directories: readonly string[];
}

export interface SandboxDiskQuota {
  /** The refusal text when a write must not happen, null when it may. */
  refusal(workspaces: readonly WorkspaceDirectories[]): Promise<string | null>;
}

const GIB = 1024 ** 3;
const gib = (bytes: number) => (bytes / GIB).toFixed(1);

export function createSandboxDiskQuota(input: {
  limitBytes?: number;
  minFreeBytes?: number;
  now: () => number;
  probe: DiskProbe;
}): SandboxDiskQuota {
  const limit = input.limitBytes ?? SANDBOX_WORKSPACE_QUOTA_BYTES;
  const minFree = input.minFreeBytes ?? SANDBOX_MIN_FREE_BYTES;
  const measured = new Map<string, { at: number; bytes: number }>();
  const pending = new Map<string, Promise<number>>();

  const usage = async (workspace: WorkspaceDirectories): Promise<number> => {
    const cached = measured.get(workspace.key);
    if (cached && input.now() - cached.at < MEASURE_TTL_MS) return cached.bytes;
    const running = pending.get(workspace.key);
    if (running) return await running;
    const measuring = input.probe.usedBytes(workspace.directories).then((bytes) => {
      measured.delete(workspace.key);
      measured.set(workspace.key, { at: input.now(), bytes });
      while (measured.size > MAX_CACHED_WORKSPACES) measured.delete(measured.keys().next().value!);
      return bytes;
    }).finally(() => pending.delete(workspace.key));
    pending.set(workspace.key, measuring);
    return await measuring;
  };

  return {
    async refusal(workspaces) {
      const free = await input.probe.freeBytes();
      if (free < minFree) {
        return "AGENT_SANDBOX_DISK_LOW: На сервере заканчивается место " +
          `(свободно ${gib(free)} ГБ), запись из песочницы остановлена. Удалите ненужные файлы командой rm ` +
          "и скажите человеку, что место на сервере на исходе.";
      }
      for (const workspace of workspaces) {
        const used = await usage(workspace);
        if (used > limit) {
          return "AGENT_SANDBOX_WORKSPACE_QUOTA_EXCEEDED: Рабочая папка занимает " +
            `${gib(used)} ГБ при лимите ${gib(limit)} ГБ, запись остановлена. Посмотрите, что занимает место ` +
            "(du -sh /workspace/* /tools/*), удалите ненужное командой rm и только потом продолжайте.";
        }
      }
      return null;
    },
  };
}

const execFileAsync = promisify(execFile);

/** `du` over the runner's volume mounts (allocated blocks, so preallocated files count in full). */
export function createHostDiskProbe(volumeRoot: string): DiskProbe {
  return {
    async freeBytes() {
      const stats = await statfs(volumeRoot);
      return Number(stats.bavail) * Number(stats.bsize);
    },
    async usedBytes(directories) {
      if (directories.length === 0) return 0;
      // A missing directory makes du exit 1 with the others still summed in its output.
      const { stdout } = await execFileAsync("du", ["-s", "-B1", "--", ...directories], {
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
      return stdout.split("\n").reduce((total, line) => {
        const bytes = Number(line.split("\t", 1)[0]);
        return Number.isFinite(bytes) ? total + bytes : total;
      }, 0);
    },
  };
}
