/**
 * Shared parts of the load runs: databases, families, server replicas, sampling.
 *
 * Exports:
 * - `db`, `workflowDb`, `databaseSizes`: the disposable databases and their sizes.
 * - `prepareFamilies`: N families in one statement each (owner, membership, family group).
 * - `ownerTelegramId`, `groupChatId`, `FIRST_UPDATE_ID`, `SECRET`: identities the runs send as.
 * - `prewarmSandboxes`, `startServer`, `waitHealthy`: the built server like production's entrypoint.
 * - `sample`, `percentile`, `sleep`: measurement helpers; `dropLoadTables` removes the harness table.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

export const root = resolve(import.meta.dirname);
const databaseUrl = process.env.DATABASE_URL!;
const workflowUrl = process.env.WORKFLOW_POSTGRES_URL!;
if (!new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("LOAD_DATABASE_UNSAFE");

export const FIRST_UPDATE_ID = 800_000_000;
export const SECRET = "load-test-secret-0123456789abcdef";
export const db = new pg.Pool({ connectionString: databaseUrl, max: 8 });
export const workflowDb = new pg.Pool({ connectionString: workflowUrl, max: 2 });
export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
export const ownerTelegramId = (index: number) => 1_000_000 + index;
export const groupChatId = (index: number) => -(900_200_000 + index);

export async function databaseSizes() {
  const app = await db.query<{ size: string }>("SELECT pg_database_size(current_database())::text AS size");
  const workflow = await workflowDb.query<{ size: string }>("SELECT pg_database_size(current_database())::text AS size");
  return { appMb: Number(app.rows[0]!.size) / 1048576, workflowMb: Number(workflow.rows[0]!.size) / 1048576 };
}

export async function prepareFamilies(families: number) {
  await db.query("TRUNCATE users, families CASCADE");
  await db.query("DELETE FROM telegram_ingress_updates WHERE update_id >= $1", [FIRST_UPDATE_ID]);
  await db.query(`CREATE TABLE IF NOT EXISTS telegram_conversation_test_deliveries (
    id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
  await db.query("TRUNCATE telegram_conversation_test_deliveries");
  if (families === 0) return;
  // Family i and owner i are paired by the index carried in their names.
  await db.query(
    `WITH f AS (
       INSERT INTO families(name) SELECT 'Load family ' || i FROM generate_series(0, $1 - 1) AS i
       RETURNING id, substring(name FROM 13)::int AS i
     ), u AS (
       INSERT INTO users(telegram_user_id, display_name)
       SELECT (1000000 + i)::text, 'Owner ' || i FROM generate_series(0, $1 - 1) AS i
       RETURNING id, telegram_user_id::bigint - 1000000 AS i
     ), m AS (
       INSERT INTO family_memberships(family_id, user_id, role)
       SELECT f.id, u.id, 'owner' FROM f JOIN u USING (i)
     )
     INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode)
     SELECT f.id, (-(900200000 + f.i))::text, 'Load group ' || f.i, 'family_private', 'all' FROM f`,
    [families],
  );
}

// Production's entrypoint prepares sandbox templates before the server starts; so do the runs.
export async function prewarmSandboxes() {
  const prewarm = resolve(root, "../../node_modules/eve/dist/src/execution/sandbox/prewarm.js");
  const code = `const { prewarmBuiltAppSandboxes } = await import(${JSON.stringify(`file://${prewarm}`)});
    await prewarmBuiltAppSandboxes({ appRoot: process.cwd(), log: (line) => console.log(line) });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: root, stdio: "inherit" });
  const [exitCode] = await new Promise<[number | null]>((done) => child.on("exit", (value) => done([value])));
  if (exitCode !== 0) throw new Error(`LOAD_PREWARM_FAILED: ${exitCode}`);
}

export interface ServerProcess {
  log: string[];
  port: number;
  server: ChildProcessByStdio<null, Readable, Readable>;
}

/**
 * `cpus` pins the replica (taskset execs node, so the pid is the server's). `LOAD_NODE_ARGS` adds
 * node flags to the server alone, for those NODE_OPTIONS refuses (`--prof`).
 */
export function startServer(port: number, cpus?: string): ServerProcess {
  const args = [...(process.env.LOAD_NODE_ARGS?.split(" ").filter(Boolean) ?? []), ".output/server/index.mjs"];
  const server = spawn(cpus ? "taskset" : process.execPath, cpus ? ["-c", cpus, process.execPath, ...args] : args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      EVE_MOCK_AUTHORED_MODELS: "0",
      HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: String(port), NITRO_PORT: String(port),
      TELEGRAM_BOT_TOKEN: "load-test-token",
      TELEGRAM_BOT_USERNAME: "osinara_load_bot",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: SECRET,
      AGENT_INTERNAL_TOKEN: "load-test-internal-token-0123456789abcdef",
      MODEL_API_KEY: "unused-load-key",
      INVITATION_SIGNING_SECRET: "load-test-signing-secret-of-32-chars!!",
      // A real embedder (TEI with BERTA) when LOAD_EMBEDDING_URL is set; otherwise an address that
      // fails fast and leaves retrieval lexical.
      MEMORY_EMBEDDING_BASE_URL: process.env.LOAD_EMBEDDING_URL ?? "http://memory-test",
      // Production values; LOAD_WORKFLOW_CONCURRENCY raises both for a scaling run.
      WORKFLOW_POSTGRES_WORKER_CONCURRENCY: process.env.LOAD_WORKFLOW_CONCURRENCY ?? "10",
      WORKFLOW_POSTGRES_MAX_POOL_SIZE: String(Number(process.env.LOAD_WORKFLOW_CONCURRENCY ?? 10) + 2),
      WORKFLOW_POSTGRES_JOB_PREFIX: "osinara",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) if (line) log.push(line);
  };
  server.stdout.on("data", keep);
  server.stderr.on("data", keep);
  return { log, port, server };
}

export async function waitHealthy(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/eve/v1/health`)).ok) return;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error(`LOAD_SERVER_NEVER_HEALTHY: ${port}`);
}

export interface Sample { cpuSeconds: number; rssMb: number; t: number }

export async function sample(pid: number): Promise<Sample | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const stat = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]!.split(" ");
    const rssKb = Number(/VmRSS:\s+(\d+)/u.exec(status)?.[1]);
    // utime and stime are fields 14 and 15 of /proc/pid/stat, in clock ticks of 100 Hz.
    return { cpuSeconds: (Number(stat[11]) + Number(stat[12])) / 100, rssMb: rssKb / 1024, t: Date.now() };
  } catch {
    return null;
  }
}

export const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

/** The delivery table is this harness's; the end-to-end conversation test creates its own copy. */
export async function dropLoadTables() {
  await db.query("DROP TABLE IF EXISTS telegram_conversation_test_deliveries");
}

export async function stopServer({ server }: ServerProcess) {
  server.kill("SIGTERM");
  await sleep(2_000);
  if (server.exitCode === null) server.kill("SIGKILL");
}
