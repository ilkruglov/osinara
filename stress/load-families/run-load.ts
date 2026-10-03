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
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  FIRST_UPDATE_ID, SECRET, databaseSizes, db, dropLoadTables, groupChatId, ownerTelegramId, percentile, prepareFamilies,
  prewarmSandboxes, root, sample, type Sample, sleep, startServer, stopServer, waitHealthy, workflowDb,
} from "./load-lib.ts";

const families = Number(process.argv[2] ?? 10);
const perFamily = Number(process.argv[3] ?? 3);
const label = process.argv[4] ?? `f${families}-m${perFamily}`;
const port = Number(process.env.LOAD_PORT ?? 3100);

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

await prepareFamilies(families);
await prewarmSandboxes();
const sizesBefore = await databaseSizes();
const replica = startServer(port, process.env.LOAD_CPUS);
const { log, server } = replica;
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
  await waitHealthy(port, 600_000);
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
  await stopServer(replica);
  await dropLoadTables();
  await db.end();
  await workflowDb.end();
}
