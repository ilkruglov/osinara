/**
 * Writes our runtime modules into the vendored Eve and Workflow Postgres world.
 *
 * Exports:
 * - `EVE_RUNTIME_MODULES`: each TypeScript source in `scripts/eve-runtime/` and the vendored
 *   JavaScript file built from it.
 * - `builtEveRuntimeModule`: the JavaScript a source compiles to (types stripped, nothing else).
 *
 * Key construct:
 * - The TypeScript stays the source with its unit tests; `vendor/` carries the built copy that
 *   the packages import. Run `npm run sync:eve-runtime` after editing a source;
 *   `vendor-sync.test.ts` fails while a copy is stale.
 */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

export const EVE_RUNTIME_MODULES = [
  ["scripts/eve-runtime/delta-pacing.ts", "vendor/eve/dist/src/harness/osinara-delta-pacing.js"],
  ["scripts/eve-runtime/ndjson-stream.ts", "vendor/eve/dist/src/execution/osinara-ndjson-stream.js"],
  ["scripts/eve-runtime/event-log-cache.ts", "vendor/workflow-world-postgres/dist/osinara-event-log-cache.js"],
  ["scripts/eve-runtime/paged-stream.ts", "vendor/workflow-world-postgres/dist/osinara-paged-stream.js"],
  ["scripts/eve-runtime/stuck-run-recovery.ts", "vendor/workflow-world-postgres/dist/osinara-stuck-run-recovery.js"],
  ["scripts/eve-runtime/workflow-pool-trace.ts", "vendor/workflow-world-postgres/dist/osinara-workflow-pool-trace.js"],
] as const;

export function projectPath(relative: string): string {
  return fileURLToPath(new URL(relative, root));
}

export async function builtEveRuntimeModule(source: string): Promise<string> {
  return stripTypeScriptTypes(await readFile(projectPath(source), "utf8"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [source, target] of EVE_RUNTIME_MODULES) {
    await writeFile(projectPath(target), await builtEveRuntimeModule(source));
    console.log(`${source} -> ${target}`);
  }
}
