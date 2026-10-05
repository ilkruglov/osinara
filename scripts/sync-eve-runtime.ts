/**
 * Writes our runtime modules into the vendored Eve and Workflow Postgres world.
 *
 * Exports:
 * - `EVE_RUNTIME_MODULES`: each TypeScript source in `scripts/eve-runtime/` and the vendored
 *   JavaScript file built from it.
 * - `builtEveRuntimeModule`: the JavaScript a source compiles to (types stripped, imports of other
 *   listed modules renamed to their vendored copies, nothing else).
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
  ["agent/lib/html-entities.ts", "vendor/eve/dist/src/execution/web-fetch/osinara-html-entities.js"],
  ["agent/lib/html-markdown.ts", "vendor/eve/dist/src/execution/web-fetch/osinara-html-markdown.js"],
  ["agent/lib/html-text.ts", "vendor/eve/dist/src/execution/web-fetch/osinara-html-text.js"],
  ["scripts/eve-runtime/ndjson-stream.ts", "vendor/eve/dist/src/execution/osinara-ndjson-stream.js"],
  ["scripts/eve-runtime/telegram-send-pacing.ts", "vendor/eve/dist/src/public/channels/telegram/osinara-telegram-send-pacing.js"],
  ["scripts/eve-runtime/event-log-cache.ts", "vendor/workflow-world-postgres/dist/osinara-event-log-cache.js"],
  ["scripts/eve-runtime/paged-stream.ts", "vendor/workflow-world-postgres/dist/osinara-paged-stream.js"],
  ["scripts/eve-runtime/payload-blobs.ts", "vendor/workflow-world-postgres/dist/osinara-payload-blobs.js"],
  ["scripts/eve-runtime/stream-listener.ts", "vendor/workflow-world-postgres/dist/osinara-stream-listener.js"],
  ["scripts/eve-runtime/stuck-run-recovery.ts", "vendor/workflow-world-postgres/dist/osinara-stuck-run-recovery.js"],
  ["scripts/eve-runtime/workflow-pool-trace.ts", "vendor/workflow-world-postgres/dist/osinara-workflow-pool-trace.js"],
] as const;

export function projectPath(relative: string): string {
  return fileURLToPath(new URL(relative, root));
}

/**
 * Our modules import each other by their source names (`./html-text.js`); the vendored copies
 * carry the `osinara-` prefix, so a relative import of another listed module in the same
 * directory is rewritten to the copy's name.
 */
function vendoredImports(source: string, code: string): string {
  const sourceDirectory = source.slice(0, source.lastIndexOf("/") + 1);
  const target = EVE_RUNTIME_MODULES.find(([from]) => from === source)?.[1] ?? "";
  const targetDirectory = target.slice(0, target.lastIndexOf("/") + 1);
  let rewritten = code;
  for (const [otherSource, otherTarget] of EVE_RUNTIME_MODULES) {
    if (otherSource === source || !otherSource.startsWith(sourceDirectory) || !otherTarget.startsWith(targetDirectory)) continue;
    const from = `"./${otherSource.slice(sourceDirectory.length).replace(/\.ts$/u, ".js")}"`;
    rewritten = rewritten.split(from).join(`"./${otherTarget.slice(targetDirectory.length)}"`);
  }
  return rewritten;
}

export async function builtEveRuntimeModule(source: string): Promise<string> {
  return vendoredImports(source, stripTypeScriptTypes(await readFile(projectPath(source), "utf8")));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [source, target] of EVE_RUNTIME_MODULES) {
    await writeFile(projectPath(target), await builtEveRuntimeModule(source));
    console.log(`${source} -> ${target}`);
  }
}
