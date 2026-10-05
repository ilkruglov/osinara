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
import { stat, statfs } from "node:fs/promises";
import { promisify } from "node:util";

export const SANDBOX_WORKSPACE_QUOTA_BYTES = 2 * 1024 ** 3;
export const SANDBOX_MIN_FREE_BYTES = 3 * 1024 ** 3;
export const SANDBOX_QUOTA_REFUSED_EXIT_CODE = 125;
const MEASURE_TTL_MS = 60_000;
const MAX_CACHED_WORKSPACES = 2_000;

/**
 * `rm`, `rmdir`, `ls`, `du` or `df` alone on one line, with no quoting, chaining, redirection or
 * substitution: enough to see what takes space and delete it, and none of them writes. `find` is
 * not among them: its actions write files (`-fprint`), and quoting hides them from any pattern
 * (Codex review, 5 October 2026). The engine runs these with the system PATH, so a binary planted
 * in the tool environment under one of the names is not what runs.
 */
export function isCleanupCommand(command: string): boolean {
  return /^[ \t]*(?:rm|rmdir|ls|du|df)(?:[ \t][^;&|`$<>(){}'"\r\n\\]*)?$/u.test(command);
}

/** The PATH a cleanup command runs with past a refusal: system binaries only. */
export const SANDBOX_CLEANUP_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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

  /** Measured bytes; a failed measurement is not cached and refuses the write (fail closed). */
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
        let used: number;
        try {
          used = await usage(workspace);
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_SANDBOX_DISK_UNMEASURED",
            error: error instanceof Error ? error.message.slice(0, 200) : String(error),
            workspace: workspace.key,
          }));
          return "AGENT_SANDBOX_DISK_UNMEASURED: Не удалось измерить, сколько места занимает рабочая папка, " +
            "запись остановлена. Удалите ненужные файлы командой rm или повторите позже.";
        }
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
      // Only a missing directory counts zero; any other failure of du (a timeout on a huge
      // tree, an unreadable entry, no du) is an error, never a partial or zero sum.
      const existing: string[] = [];
      for (const directory of directories) {
        try {
          if ((await stat(directory)).isDirectory()) existing.push(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (existing.length === 0) return 0;
      const { stdout } = await execFileAsync("du", ["-s", "-B1", "--", ...existing], {
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      });
      const sizes = stdout.trim().split("\n").map((line) => Number(line.split("\t", 1)[0]));
      if (sizes.length !== existing.length || sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) {
        throw new Error(`AGENT_SANDBOX_DISK_UNMEASURED: du printed ${sizes.length} sizes for ${existing.length} directories`);
      }
      return sizes.reduce((total, size) => total + size, 0);
    },
  };
}
