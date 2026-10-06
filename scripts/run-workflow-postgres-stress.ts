/**
 * Deterministic PostgreSQL Workflow stress runner.
 *
 * Runtime:
 * - Runs the isolated 300-turn Eve eval fixture with the repository Eve binary.
 * - Deletes generated build, discovery, and report artifacts on every exit path.
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureRoot = resolve("stress", "workflow-postgres");
const generatedPaths = [".eve", ".output", "eval-results", "reports"];

// The fixture's queue posts every delivery to the agent's flow route with this token (6 October
// 2026); without it every job would fail inside Eve and the eval would report no answers.
if (!process.env.AGENT_INTERNAL_TOKEN) {
  throw new Error(
    "AGENT_INTERNAL_TOKEN_MISSING: Стресс-стенд Workflow требует AGENT_INTERNAL_TOKEN в окружении (compose.test.yaml задаёт его сервису workflow-stress)",
  );
}

const child = spawn(
  resolve("node_modules", ".bin", "eve"),
  ["eval", "retention", "--max-concurrency", "1", "--timeout", "2400000", "--verbose"],
  {
    cwd: fixtureRoot,
    env: process.env,
    stdio: "inherit",
  },
);
let exitCode: number | null;
try {
  exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
} finally {
  await Promise.all(generatedPaths.map((path) =>
    rm(resolve(fixtureRoot, path), { force: true, recursive: true })
  ));
}
if (exitCode !== 0) {
  throw new Error(
    `AGENT_WORKFLOW_STRESS_FAILED: PostgreSQL Workflow stress gate завершился с кодом ${String(exitCode)}`,
  );
}
