/**
 * Eve 0.32.0 local-workflow physical retention adapter.
 *
 * Export:
 * - `deleteLocalEveSession`: removes one run and all known local-world references.
 *
 * Key constructs:
 * - Lock namespace cleanup: removes exact run, step, wait, and hook lock entries.
 * - Secondary verification: proves references absent before deleting the primary run record.
 */
import { access, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "../app-error.js";

const EVE_RUN_ID_PATTERN = /^wrun_[A-Z0-9]{26}$/u;
const EVE_STORAGE_VERSION = "0.32.0";
const EVENTS_DIRECTORY = "events";
const STEPS_DIRECTORY = "steps";
const WAITS_DIRECTORY = "waits";
const LOCKS_DIRECTORY = ".locks";

interface FileEntry {
  path: string;
  relativePath: string;
}

interface HookIdentityIndexes {
  hookIds: string[];
  paths: string[];
}

async function listFiles(root: string, relative = ""): Promise<FileEntry[]> {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const childRelative = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, childRelative));
    } else if (entry.isFile()) {
      files.push({ path: join(root, childRelative), relativePath: childRelative });
    }
  }
  return files;
}

async function requireRun(root: string, runId: string): Promise<void> {
  try {
    await readFile(join(root, "runs", `${runId}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new AppError(
      "AGENT_EVE_SESSION_STORAGE_MISSING",
      `Не найдены данные удаляемой Eve-сессии ${runId}`,
    );
  }
}

async function streamIds(root: string, runId: string): Promise<string[]> {
  try {
    const raw = JSON.parse(
      await readFile(join(root, "streams", "runs", `${runId}.json`), "utf8"),
    ) as { streams?: unknown };
    if (!Array.isArray(raw.streams) || !raw.streams.every((value) => typeof value === "string")) {
      throw new Error("stream list is invalid");
    }
    return raw.streams;
  } catch (error) {
    throw new AppError(
      "AGENT_EVE_SESSION_STORAGE_LAYOUT_INVALID",
      `Структура потоков Eve-сессии ${runId} не соответствует версии ${EVE_STORAGE_VERSION}: ${String(error)}`,
    );
  }
}

async function hookIdentityIndexes(root: string, runId: string): Promise<HookIdentityIndexes> {
  const byRunRoot = join(root, "hooks", "by-run");
  const files = (await readdir(byRunRoot)).filter((name) => name.startsWith(`${runId}-`));
  const ids = new Set<string>();
  for (const name of files) {
    const raw = JSON.parse(await readFile(join(byRunRoot, name), "utf8")) as { hookId?: unknown };
    if (typeof raw.hookId !== "string" || !raw.hookId.startsWith("hook_")) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_LAYOUT_INVALID",
        `Индекс hook Eve-сессии ${runId} повреждён`,
      );
    }
    ids.add(raw.hookId);
  }
  return {
    hookIds: [...ids],
    paths: files.map((name) => join(byRunRoot, name)),
  };
}

async function removePrefixedEntries(
  root: string,
  prefix: string,
  allowMissingRoot: boolean,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    // world-local materializes `waits/` only after the first durable wait; other roots are required.
    if (allowMissingRoot && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) =>
    rm(join(root, name), { force: true, recursive: true })
  ));
}

async function requireNoPrefixedEntries(
  root: string,
  prefix: string,
  allowMissingRoot: boolean,
  runId: string,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    // Lock and wait roots are lazy in world-local, but required roots still prove the fixed layout.
    if (allowMissingRoot && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.some((name) => name.startsWith(prefix))) {
    throw new AppError(
      "AGENT_EVE_SESSION_STORAGE_DELETE_INCOMPLETE",
      `Не удалось полностью удалить ссылки Eve-сессии ${runId}`,
    );
  }
}

async function requireMissing(path: string, runId: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new AppError(
    "AGENT_EVE_SESSION_STORAGE_DELETE_INCOMPLETE",
    `Не удалось полностью удалить данные Eve-сессии ${runId}`,
  );
}

async function requireNoHookReferences(
  root: string,
  references: readonly string[],
  runId: string,
  ignoredExactPaths: ReadonlySet<string>,
): Promise<void> {
  const remainingHookFiles = await listFiles(join(root, "hooks"));
  for (const file of remainingHookFiles) {
    if (!file.relativePath.endsWith(".json")) continue;
    if (ignoredExactPaths.has(file.path)) continue;
    const content = await readFile(file.path, "utf8");
    if (references.some((reference) => content.includes(reference))) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_DELETE_INCOMPLETE",
        `Не удалось полностью удалить индексы Eve-сессии ${runId}`,
      );
    }
  }
}

export async function deleteLocalEveSession(root: string, runId: string): Promise<{
  hookCount: number;
  streamCount: number;
}> {
  if (!EVE_RUN_ID_PATTERN.test(runId)) {
    throw new AppError("AGENT_EVE_SESSION_ID_INVALID", "Идентификатор удаляемой Eve-сессии некорректен");
  }
  await requireRun(root, runId);

  // Read secondary identifiers before deleting primary records.
  const streams = await streamIds(root, runId);
  const hookIdentity = await hookIdentityIndexes(root, runId);
  const hooks = hookIdentity.hookIds;
  const retainedHookIndexPaths = new Set(hookIdentity.paths);
  const hookFiles = await listFiles(join(root, "hooks"));
  const hookReferences = [runId, ...hooks];
  const hookFilesToDelete: string[] = [];
  for (const file of hookFiles) {
    if (!file.relativePath.endsWith(".json")) continue;
    if (retainedHookIndexPaths.has(file.path)) continue;
    const content = await readFile(file.path, "utf8");
    if (hookReferences.some((reference) => content.includes(reference))) {
      hookFilesToDelete.push(file.path);
    }
  }

  const locksRoot = join(root, LOCKS_DIRECTORY);

  // Delete content and references while both identity indexes remain available to a retry.
  await Promise.all([
    removePrefixedEntries(join(root, STEPS_DIRECTORY), `${runId}-`, false),
    removePrefixedEntries(join(root, EVENTS_DIRECTORY), `${runId}-`, false),
    removePrefixedEntries(join(root, WAITS_DIRECTORY), `${runId}-`, true),
    removePrefixedEntries(join(locksRoot, "runs"), `${runId}.`, true),
    removePrefixedEntries(join(locksRoot, "steps"), `${runId}-`, true),
    removePrefixedEntries(join(locksRoot, "waits"), `${runId}-`, true),
    ...hooks.map((hookId) =>
      removePrefixedEntries(join(locksRoot, "hooks"), `${hookId}.`, true)
    ),
    ...streams.map((streamId) =>
      rm(join(root, "streams", "chunks", streamId), { force: true, recursive: true })
    ),
    ...hookFilesToDelete.map((path) => rm(path, { force: true })),
  ]);

  // Prove the content phase complete while ignoring only the exact retained by-run identity files.
  const streamRunPath = join(root, "streams", "runs", `${runId}.json`);
  await Promise.all([
    requireNoPrefixedEntries(join(root, STEPS_DIRECTORY), `${runId}-`, false, runId),
    requireNoPrefixedEntries(join(root, EVENTS_DIRECTORY), `${runId}-`, false, runId),
    requireNoPrefixedEntries(join(root, WAITS_DIRECTORY), `${runId}-`, true, runId),
    requireNoPrefixedEntries(join(locksRoot, "runs"), `${runId}.`, true, runId),
    requireNoPrefixedEntries(join(locksRoot, "steps"), `${runId}-`, true, runId),
    requireNoPrefixedEntries(join(locksRoot, "waits"), `${runId}-`, true, runId),
    ...hooks.map((hookId) =>
      requireNoPrefixedEntries(join(locksRoot, "hooks"), `${hookId}.`, true, runId)
    ),
    ...streams.map((streamId) =>
      requireMissing(join(root, "streams", "chunks", streamId), runId)
    ),
    requireNoHookReferences(root, hookReferences, runId, retainedHookIndexPaths),
  ]);

  // Identity indexes are removed only after all content, lock, and non-identity references verify.
  await Promise.all([
    rm(streamRunPath, { force: true }),
    ...hookIdentity.paths.map((path) => rm(path, { force: true })),
  ]);

  // Final verification permits no retained identity index or other hook reference.
  await Promise.all([
    requireMissing(streamRunPath, runId),
    ...hookIdentity.paths.map((path) => requireMissing(path, runId)),
    requireNoHookReferences(root, hookReferences, runId, new Set<string>()),
  ]);

  // The primary run record remains the strictly final storage mutation.
  await requireRun(root, runId);
  await rm(join(root, "runs", `${runId}.json`), { force: true });
  return { hookCount: hooks.length, streamCount: streams.length };
}
