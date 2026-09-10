/** Version-pinned seam: the resume read of an append-only event log fetches only its tail. */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

const OLD_IMPORT = `import { Schema } from './drizzle/index.js';`;

const NEW_IMPORT = `import { Schema } from './drizzle/index.js';
import { dropEventLogCache, eventLogCacheKey, readEventLogCache, writeEventLogCache, } from './osinara-event-log-cache.js';`;

const OLD_HEAD = `            const resolveData = params.resolveData ?? 'all';
            const data = [];
            let cursor = params.pagination?.cursor;
            let hasMore = false;`;

const NEW_HEAD = `            const resolveData = params.resolveData ?? 'all';
            // Resuming a run lists its whole log with no payloads. The log only grows, so a run
            // already read in this process is compared by row count and extended by its tail.
            const cacheKey = eventLogCacheKey(params, resolveData, sortOrder);
            let cached = cacheKey === null ? undefined : readEventLogCache(cacheKey);
            if (cacheKey !== null && cached !== undefined) {
                if (cached.data.length >= limit) {
                    cached = undefined;
                }
                else {
                    const [counted] = await drizzle
                        .select({ total: sql \`count(*)\` })
                        .from(events)
                        .where(eq(events.runId, params.runId));
                    const total = Number(counted?.total ?? 0);
                    if (total < cached.data.length) {
                        dropEventLogCache(cacheKey);
                        cached = undefined;
                    }
                    else if (total === cached.data.length) {
                        return {
                            data: [...cached.data],
                            cursor: cached.cursor ?? null,
                            hasMore: false,
                        };
                    }
                }
            }
            const data = cached === undefined ? [] : [...cached.data];
            let cursor = cached === undefined ? params.pagination?.cursor : cached.cursor;
            let hasMore = false;`;

const OLD_RETURN = `            return {
                data,
                cursor: data.at(-1)?.eventId ?? null,
                hasMore,
            };
        },
        async listByCorrelationId(params) {`;

const NEW_RETURN = `            // Only a listing that reached the end of the log may be reused as a prefix.
            if (cacheKey !== null && !hasMore) {
                writeEventLogCache(cacheKey, data, data.at(-1)?.eventId);
            }
            return {
                data,
                cursor: data.at(-1)?.eventId ?? null,
                hasMore,
            };
        },
        async listByCorrelationId(params) {`;

export async function patchEventLogCache(
  replace: (path: string, before: string, after: string) => Promise<void>,
): Promise<void> {
  const world = resolve("node_modules/@workflow/world-postgres");
  const pkg = JSON.parse(await readFile(`${world}/package.json`, "utf8")) as { version: string };
  if (pkg.version !== "5.0.0-beta.35") {
    throw new Error("AGENT_WORKFLOW_PATCH_VERSION_UNSUPPORTED: Expected world-postgres 5.0.0-beta.35");
  }
  await writeFile(
    `${world}/dist/osinara-event-log-cache.js`,
    stripTypeScriptTypes(await readFile("scripts/eve-runtime/event-log-cache.ts", "utf8")),
  );
  const storage = `${world}/dist/storage.js`;
  await replace(storage, OLD_IMPORT, NEW_IMPORT);
  await replace(storage, OLD_HEAD, NEW_HEAD);
  await replace(storage, OLD_RETURN, NEW_RETURN);
}
