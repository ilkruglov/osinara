/**
 * One-shot sandbox template preparation before the agent server starts.
 *
 * Key construct:
 * - `eve start` loads the app's env files, prepares sandbox templates and then only supervises the
 *   built server as a child: on 2 October 2026 that idle parent held 355 MB and the `npm run start`
 *   wrapper above it 78 MB, half of the agent container. The entrypoint now runs the same two
 *   preparation calls here, exits, and executes `.output/server/index.mjs` itself.
 * - Eve exports neither call publicly, so they are loaded from the pinned package by file path;
 *   Eve is our fork in `vendor/eve`, so these paths change only with a reviewed commit there.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = process.cwd();
const eveModule = (path: string): string =>
  pathToFileURL(resolve(appRoot, "node_modules/eve/dist/src", path)).href;

const { loadDevelopmentEnvironmentFiles } = await import(eveModule("cli/dev/environment.js")) as {
  loadDevelopmentEnvironmentFiles(root: string): void;
};
const { prewarmBuiltAppSandboxes } = await import(eveModule("execution/sandbox/prewarm.js")) as {
  prewarmBuiltAppSandboxes(input: { appRoot: string; log: (line: string) => void }): Promise<void>;
};

loadDevelopmentEnvironmentFiles(appRoot);
await prewarmBuiltAppSandboxes({ appRoot, log: (line) => console.log(line) });
