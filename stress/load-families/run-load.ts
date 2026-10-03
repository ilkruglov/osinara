/**
 * Many-family load run against the built load agent.
 *
 * Build once from this directory (the copies are git-ignored):
 *   cp ../../agent/instructions.md agent/ && cp -r ../../config . &&
 *   for s in ../../agent/skills/*\/; do cp -r "$s" agent/skills/; done && ../../node_modules/.bin/eve build
 * Disposable databases: a pgvector container and `npm run migrate` from the repository root.
 *
 * Usage: node --experimental-strip-types run-load.ts <families> <messages per family> [label]
 * Env: DATABASE_URL and WORKFLOW_POSTGRES_URL of disposable databases, LOAD_MODEL_LATENCY_MS,
 * LOAD_CPUS (taskset list for the server, e.g. `0` for production's single core).
 *
 * Every family has an owner and a family group. Each family sends its messages one after another
 * through the real webhook, alternating the private chat and the group, and waits for the ingress
 * row to complete (a person waiting for the answer); families run concurrently. The server runs
 * as its own process, like production; RSS and CPU time of that process are sampled every second.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const families = Number(process.argv[2] ?? 10);
const perFamily = Number(process.argv[3] ?? 3);
const label = process.argv[4] ?? `f${families}-m${perFamily}`;
const port = Number(process.env.LOAD_PORT ?? 3100);
const root = resolve(import.meta.dirname);
const databaseUrl = process.env.DATABASE_URL!;
const workflowUrl = process.env.WORKFLOW_POSTGRES_URL!;
if (!new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("LOAD_DATABASE_UNSAFE");
const FIRST_UPDATE_ID = 800_000_000;
const SECRET = "load-test-secret";

const db = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const workflowDb = new pg.Pool({ connectionString: workflowUrl, max: 2 });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function databaseSizes() {
  const app = await db.query<{ size: string }>("SELECT pg_database_size(current_database())::text AS size");
  const workflow = await workflowDb.query<{ size: string }>("SELECT pg_database_size(current_database())::text AS size");
  return { appMb: Number(app.rows[0]!.size) / 1048576, workflowMb: Number(workflow.rows[0]!.size) / 1048576 };
}

async function prepare() {
  await db.query("TRUNCATE users, families CASCADE");
  await db.query("DELETE FROM telegram_ingress_updates WHERE update_id >= $1", [FIRST_UPDATE_ID]);
  await db.query(`CREATE TABLE IF NOT EXISTS telegram_conversation_test_deliveries (
    id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
  await db.query("TRUNCATE telegram_conversation_test_deliveries");
  for (let index = 0; index < families; index += 1) {
    const family = (await db.query<{ id: string }>(
      "INSERT INTO families(name) VALUES ($1) RETURNING id", [`Load family ${index}`],
    )).rows[0]!;
    const owner = (await db.query<{ id: string }>(
      "INSERT INTO users(telegram_user_id, display_name) VALUES ($1, $2) RETURNING id",
      [String(ownerTelegramId(index)), `Owner ${index}`],
    )).rows[0]!;
    await db.query("INSERT INTO family_memberships(family_id, user_id, role) VALUES ($1, $2, 'owner')", [family.id, owner.id]);
    await db.query(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, $2, $3, 'family_private', 'all')`,
      [family.id, String(groupChatId(index)), `Load group ${index}`],
    );
  }
}

const ownerTelegramId = (index: number) => 1_000_000 + index;
const groupChatId = (index: number) => -(900_200_000 + index);

function startServer() {
  // LOAD_CPUS pins the server like production's single core (taskset execs node: same pid).
  const pin = process.env.LOAD_CPUS;
  const server = spawn(pin ? "taskset" : process.execPath, pin
    ? ["-c", pin, process.execPath, ".output/server/index.mjs"]
    : [".output/server/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      EVE_MOCK_AUTHORED_MODELS: "0",
      HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: String(port), NITRO_PORT: String(port),
      TELEGRAM_BOT_TOKEN: "load-test-token",
      TELEGRAM_BOT_USERNAME: "osinara_load_bot",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: SECRET,
      MODEL_API_KEY: "unused-load-key",
      INVITATION_SIGNING_SECRET: "load-test-signing-secret-of-32-chars!!",
      MEMORY_EMBEDDING_BASE_URL: "http://memory-test",
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
  return { log, server };
}

async function waitHealthy(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/eve/v1/health`)).ok) return;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error("LOAD_SERVER_NEVER_HEALTHY");
}

interface Sample { cpuSeconds: number; rssMb: number; t: number }

async function sample(pid: number): Promise<Sample | null> {
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

async function sendAndWait(updateId: number, chatId: number, fromId: number, text: string) {
  const sent = Date.now();
  const message = {
    message_id: updateId - FIRST_UPDATE_ID,
    chat: chatId > 0 ? { id: chatId, type: "private", first_name: "Owner" } : { id: chatId, type: "supergroup", title: "Load group" },
    date: Math.floor(sent / 1_000),
    from: { id: fromId, first_name: "Owner", is_bot: false },
    text,
  };
  const response = await fetch(`http://127.0.0.1:${port}/eve/v1/telegram`, {
    body: JSON.stringify({ update_id: updateId, message }),
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    method: "POST",
  });
  if (response.status !== 200) return { latencyMs: Date.now() - sent, status: `http-${response.status}` };
  for (;;) {
    const row = (await db.query<{ status: string; last_error_code: string | null }>(
      "SELECT status, last_error_code FROM telegram_ingress_updates WHERE update_id = $1", [updateId],
    )).rows[0];
    if (row?.status === "completed") return { latencyMs: Date.now() - sent, status: "completed" };
    if (row?.status === "failed") return { latencyMs: Date.now() - sent, status: `failed:${row.last_error_code}` };
    if (Date.now() - sent > 15 * 60_000) return { latencyMs: Date.now() - sent, status: "timeout" };
    await sleep(250);
  }
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

// Production's entrypoint prepares sandbox templates before the server starts; so does the run.
async function prewarmSandboxes() {
  const prewarm = resolve(root, "../../node_modules/eve/dist/src/execution/sandbox/prewarm.js");
  const code = `const { prewarmBuiltAppSandboxes } = await import(${JSON.stringify(`file://${prewarm}`)});
    await prewarmBuiltAppSandboxes({ appRoot: process.cwd(), log: (line) => console.log(line) });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: root, stdio: "inherit" });
  const [exitCode] = await new Promise<[number | null]>((done) => child.on("exit", (codeValue) => done([codeValue])));
  if (exitCode !== 0) throw new Error(`LOAD_PREWARM_FAILED: ${exitCode}`);
}

await prepare();
await prewarmSandboxes();
const sizesBefore = await databaseSizes();
const { log, server } = startServer();
const samples: Sample[] = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const value = await sample(server.pid!);
    if (value) samples.push(value);
    await sleep(1_000);
  }
})();
try {
  const bootStarted = Date.now();
  await waitHealthy(600_000);
  const healthySeconds = (Date.now() - bootStarted) / 1_000;
  await sleep(5_000);
  const baseline = await sample(server.pid!);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: families }, async (_, index) => {
    const own: Array<{ latencyMs: number; status: string }> = [];
    for (let ordinal = 1; ordinal <= perFamily; ordinal += 1) {
      const privateChat = ordinal % 2 === 1;
      const updateId = FIRST_UPDATE_ID + index * 1_000 + ordinal;
      own.push(await sendAndWait(
        updateId,
        privateChat ? ownerTelegramId(index) : groupChatId(index),
        ownerTelegramId(index),
        `Мия, load-probe-${index}-${ordinal}`,
      ));
    }
    return own;
  }));
  const wallMs = Date.now() - started;
  const afterLoad = await sample(server.pid!);
  await sleep(20_000);
  const idle = await sample(server.pid!);
  const flat = results.flat();
  const done = flat.filter((r) => r.status === "completed");
  const failedSessions = log.filter((line) => line.includes("emitting terminal session.failed")).length;
  const during = samples.filter((s) => s.t >= started && s.t <= started + wallMs);
  const report = {
    label,
    healthySeconds,
    openWorkflowRuns: Number((await workflowDb.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM workflow.workflow_runs WHERE status IN ('pending', 'running')",
    )).rows[0]!.n),
    families,
    messagesPerFamily: perFamily,
    modelLatencyMs: Number(process.env.LOAD_MODEL_LATENCY_MS ?? 5_000),
    completed: done.length,
    failedSessions,
    failures: flat.filter((r) => r.status !== "completed").map((r) => r.status),
    wallSeconds: wallMs / 1_000,
    turnsPerMinute: done.length / (wallMs / 60_000),
    latencySeconds: {
      p50: percentile(done.map((r) => r.latencyMs), 0.5) / 1_000,
      p95: percentile(done.map((r) => r.latencyMs), 0.95) / 1_000,
      max: done.length ? Math.max(...done.map((r) => r.latencyMs)) / 1_000 : 0,
    },
    rssMb: {
      baseline: baseline?.rssMb,
      peak: Math.max(0, ...during.map((s) => s.rssMb)),
      afterLoad: afterLoad?.rssMb,
      idleAfter20s: idle?.rssMb,
    },
    cpuSeconds: {
      total: afterLoad && baseline ? afterLoad.cpuSeconds - baseline.cpuSeconds : null,
      perTurn: afterLoad && baseline && done.length ? (afterLoad.cpuSeconds - baseline.cpuSeconds) / done.length : null,
      utilisation: afterLoad && baseline ? (afterLoad.cpuSeconds - baseline.cpuSeconds) / (wallMs / 1_000) : null,
    },
    databaseMb: { before: sizesBefore, after: await databaseSizes() },
    deliveries: Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM telegram_conversation_test_deliveries")).rows[0]!.n),
    serverErrors: log.filter((line) => /"code":"AGENT_[A-Z_]*(FAILED|UNAVAILABLE|INVALID)/u.test(line)).slice(0, 10),
  };
  await mkdir(resolve(root, "results"), { recursive: true });
  await writeFile(resolve(root, "results", `${label}.json`), JSON.stringify({ report, samples }, null, 2));
  await writeFile(resolve(root, "results", `${label}.log`), log.join("\n"));
  console.log(JSON.stringify(report, null, 2));
} finally {
  sampling = false;
  await sampler;
  server.kill("SIGTERM");
  await sleep(2_000);
  if (server.exitCode === null) server.kill("SIGKILL");
  await db.end();
  await workflowDb.end();
}
