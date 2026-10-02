/**
 * The queue's call to the agent's own flow route outlasts any step.
 *
 * Export:
 * - `patchQueueLoopbackTimeout`: switches that call to undici's fetch with long header and body
 *   timeouts.
 *
 * Key construct:
 * - world-postgres runs every queued step by POSTing to the agent's flow route with Node's fetch,
 *   whose header wait is fixed at 300 s. On 1 October 2026 DeepSeek held requests for up to 900 s:
 *   each attempt timed out at 300 s while the step still ran, the queue retried (a second model
 *   call for the same step), the retry was told the step was in flight and reported it skipped,
 *   and the retry the first execution finally asked for went to a closed connection. The step
 *   stayed pending with no job until a restart. The loopback now waits 20 minutes, above the
 *   900 s ceiling of Workflow's inline ownership lease and the agent's own model deadlines.
 * - undici's own fetch is used with its own Agent: Node's built-in fetch bundles a different
 *   undici major, and a dispatcher from another major is not compatible with it.
 */
import { readFile } from "node:fs/promises";

const OLD_IMPORT = `import { z } from 'zod/v4';`;

const NEW_IMPORT = `import { z } from 'zod/v4';
import { Agent as OsinaraLoopbackAgent, fetch as osinaraLoopbackFetch } from 'undici';
// Above Workflow's 900 s inline ownership ceiling, so a long step settles before the call gives up.
const OSINARA_LOOPBACK_TIMEOUT_MS = 20 * 60 * 1000;
const OSINARA_LOOPBACK_DISPATCHER = new OsinaraLoopbackAgent({
    headersTimeout: OSINARA_LOOPBACK_TIMEOUT_MS,
    bodyTimeout: OSINARA_LOOPBACK_TIMEOUT_MS,
});`;

const OLD_FETCH = `        const response = await fetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {
            method: 'POST',
            duplex: 'half',
            headers,
            body,
            signal: abortSignal,
        });`;

const NEW_FETCH = `        const response = await osinaraLoopbackFetch(createWorkflowUrl(baseUrl, { type: 'flow' }), {
            method: 'POST',
            duplex: 'half',
            headers,
            body,
            signal: abortSignal,
            dispatcher: OSINARA_LOOPBACK_DISPATCHER,
        });`;

type ReplaceExact = (path: string, before: string, after: string, expectedCount?: number) => Promise<void>;

export async function patchQueueLoopbackTimeout(replaceExact: ReplaceExact): Promise<void> {
  const pkg = JSON.parse(await readFile("node_modules/@workflow/world-postgres/package.json", "utf8")) as { version: string };
  if (pkg.version !== "5.0.0-beta.35") {
    throw new Error("AGENT_WORKFLOW_PATCH_VERSION_UNSUPPORTED: Expected world-postgres 5.0.0-beta.35");
  }
  const queue = "node_modules/@workflow/world-postgres/dist/queue.js";
  await replaceExact(queue, OLD_IMPORT, NEW_IMPORT);
  await replaceExact(queue, OLD_FETCH, NEW_FETCH);
}
