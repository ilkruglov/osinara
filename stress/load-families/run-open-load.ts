/**
 * Open-loop load: messages arrive at a fixed average rate, whatever the bot manages.
 *
 * Usage: node --experimental-strip-types run-open-load.ts <families> <turns a minute> <minutes> [label]
 * Env: as run-load.ts, plus LOAD_REPLICAS (server processes on one database, default 1; replica k
 * listens on 3100 + k and is pinned to core k when LOAD_CPUS=auto), LOAD_DRAIN_MINUTES (how long
 * to wait for the backlog after arrivals stop, default 5).
 *
 * Arrivals are Poisson: each message goes to a random family, to its private chat or its group with
 * equal odds, and to the replicas in turn (a load balancer). A message is done when its ingress row
 * completes. The run reports per-minute arrivals, completions, backlog and answer latency, so a
 * steady state and a growing queue look different.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  FIRST_UPDATE_ID, SECRET, databaseSizes, db, groupChatId, ownerTelegramId, percentile, prepareFamilies,
  prewarmSandboxes, root, sample, type Sample, sleep, startServer, stopServer, waitHealthy, workflowDb,
} from "./load-lib.ts";

const families = Number(process.argv[2] ?? 1_000);
const ratePerMinute = Number(process.argv[3] ?? 104);
const minutes = Number(process.argv[4] ?? 10);
const label = process.argv[5] ?? `open-f${families}-r${ratePerMinute}`;
const replicas = Number(process.env.LOAD_REPLICAS ?? 1);
const drainMinutes = Number(process.env.LOAD_DRAIN_MINUTES ?? 5);
const cpusFor = (k: number) => process.env.LOAD_CPUS === "auto" ? String(k) : process.env.LOAD_CPUS;

interface Message { at: number; doneAt?: number; status?: string; updateId: number }

await prepareFamilies(families);
await prewarmSandboxes();
const sizesBefore = await databaseSizes();
const servers = Array.from({ length: replicas }, (_, k) => startServer(3100 + k, cpusFor(k)));
const samples = new Map<number, Sample[]>(servers.map((_, k) => [k, []]));
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    await Promise.all(servers.map(async ({ server }, k) => {
      const value = await sample(server.pid!);
      if (value) samples.get(k)!.push(value);
    }));
    await sleep(1_000);
  }
})();

const messages = new Map<number, Message>();
try {
  await Promise.all(servers.map(({ port }) => waitHealthy(port, 600_000)));
  await sleep(5_000);
  const cpuAtStart = await Promise.all(servers.map(({ server }) => sample(server.pid!)));
  const started = Date.now();
  const arrivalsEnd = started + minutes * 60_000;
  let nextUpdate = FIRST_UPDATE_ID;
  let roundRobin = 0;
  const posts: Promise<void>[] = [];

  // Completion tracker: one query a second for everything still outstanding.
  let tracking = true;
  const tracker = (async () => {
    while (tracking) {
      const open = [...messages.values()].filter((m) => m.doneAt === undefined).map((m) => m.updateId);
      for (let offset = 0; offset < open.length; offset += 5_000) {
        const rows = (await db.query<{ update_id: string; status: string; done: string }>(
          `SELECT update_id::text, status, (extract(epoch FROM coalesce(completed_at, updated_at)) * 1000)::bigint::text AS done
             FROM telegram_ingress_updates WHERE update_id = ANY($1::bigint[]) AND status IN ('completed', 'failed')`,
          [open.slice(offset, offset + 5_000)],
        )).rows;
        for (const row of rows) {
          const message = messages.get(Number(row.update_id))!;
          message.doneAt = Number(row.done);
          message.status = row.status;
        }
      }
      await sleep(1_000);
    }
  })();

  while (Date.now() < arrivalsEnd) {
    // Exponential gaps give a Poisson stream with the requested mean rate.
    await sleep(-Math.log(1 - Math.random()) * 60_000 / ratePerMinute);
    const index = Math.floor(Math.random() * families);
    const privateChat = Math.random() < 0.5;
    const updateId = nextUpdate++;
    const chatId = privateChat ? ownerTelegramId(index) : groupChatId(index);
    const message = {
      message_id: updateId - FIRST_UPDATE_ID + 1,
      chat: privateChat ? { id: chatId, type: "private", first_name: "Owner" } : { id: chatId, type: "supergroup", title: "Load group" },
      date: Math.floor(Date.now() / 1_000),
      from: { id: ownerTelegramId(index), first_name: "Owner", is_bot: false },
      text: `Мия, load-probe-${index}-${updateId}`,
    };
    const port = servers[roundRobin++ % replicas]!.port;
    messages.set(updateId, { at: Date.now(), updateId });
    posts.push(fetch(`http://127.0.0.1:${port}/eve/v1/telegram`, {
      body: JSON.stringify({ update_id: updateId, message }),
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      method: "POST",
    }).then((response) => {
      if (response.status !== 200) Object.assign(messages.get(updateId)!, { doneAt: Date.now(), status: `http-${response.status}` });
    }, (error: unknown) => {
      Object.assign(messages.get(updateId)!, { doneAt: Date.now(), status: `post-${String(error)}` });
    }));
  }
  await Promise.all(posts);
  const backlogAtArrivalsEnd = [...messages.values()].filter((m) => m.doneAt === undefined).length;
  const drainDeadline = Date.now() + drainMinutes * 60_000;
  while (Date.now() < drainDeadline && [...messages.values()].some((m) => m.doneAt === undefined)) await sleep(2_000);
  tracking = false;
  await tracker;
  const finished = Date.now();
  const cpuAtEnd = await Promise.all(servers.map(({ server }) => sample(server.pid!)));

  const all = [...messages.values()];
  const done = all.filter((m) => m.status === "completed");
  const perMinute = Array.from({ length: Math.ceil((finished - started) / 60_000) }, (_, minute) => {
    const from = started + minute * 60_000;
    const to = from + 60_000;
    const completed = done.filter((m) => m.doneAt! >= from && m.doneAt! < to);
    const latencies = completed.map((m) => (m.doneAt! - m.at) / 1_000);
    const peakRss = servers.map((_, k) => Math.max(0, ...samples.get(k)!.filter((s) => s.t >= from && s.t < to).map((s) => s.rssMb)));
    return {
      minute: minute + 1,
      arrived: all.filter((m) => m.at >= from && m.at < to).length,
      completed: completed.length,
      backlog: all.filter((m) => m.at < to && (m.doneAt === undefined || m.doneAt >= to)).length,
      latencyP50: percentile(latencies, 0.5),
      latencyP95: percentile(latencies, 0.95),
      peakRssMb: peakRss.map(Math.round),
    };
  });
  const steady = done.filter((m) => m.at >= arrivalsEnd - 3 * 60_000 && m.at < arrivalsEnd).map((m) => (m.doneAt! - m.at) / 1_000);
  const failedSessions = servers.reduce((n, s) => n + s.log.filter((l) => l.includes("emitting terminal session.failed")).length, 0);
  const report = {
    label, families, ratePerMinute, minutes, replicas,
    modelLatencyMs: Number(process.env.LOAD_MODEL_LATENCY_MS ?? 5_000),
    drains: Number(process.env.TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS ?? 3),
    workflowConcurrency: Number(process.env.LOAD_WORKFLOW_CONCURRENCY ?? 10),
    sent: all.length,
    completed: done.length,
    failed: all.filter((m) => m.status !== undefined && m.status !== "completed").map((m) => m.status).slice(0, 10),
    failedSessions,
    backlogAtArrivalsEnd,
    unfinishedAfterDrain: all.filter((m) => m.doneAt === undefined).length,
    completedPerMinuteDuringArrivals: done.filter((m) => m.doneAt! < arrivalsEnd).length / minutes,
    latencySeconds: {
      p50: percentile(done.map((m) => (m.doneAt! - m.at) / 1_000), 0.5),
      p95: percentile(done.map((m) => (m.doneAt! - m.at) / 1_000), 0.95),
      max: Math.max(0, ...done.map((m) => (m.doneAt! - m.at) / 1_000)),
      lastThreeMinutesOfArrivalsP50: percentile(steady, 0.5),
      lastThreeMinutesOfArrivalsP95: percentile(steady, 0.95),
    },
    servers: servers.map((_, k) => {
      const own = samples.get(k)!.filter((s) => s.t >= started && s.t <= finished);
      const cpu = cpuAtEnd[k] && cpuAtStart[k] ? cpuAtEnd[k]!.cpuSeconds - cpuAtStart[k]!.cpuSeconds : null;
      return {
        peakRssMb: Math.round(Math.max(0, ...own.map((s) => s.rssMb))),
        cpuUtilisation: cpu === null ? null : cpu / ((finished - started) / 1_000),
      };
    }),
    cpuSecondsPerTurn: done.length
      ? cpuAtEnd.reduce((sum, end, k) => sum + (end && cpuAtStart[k] ? end.cpuSeconds - cpuAtStart[k]!.cpuSeconds : 0), 0) / done.length
      : null,
    databaseMb: { before: sizesBefore, after: await databaseSizes() },
    perMinute,
  };
  await mkdir(resolve(root, "results"), { recursive: true });
  await writeFile(resolve(root, "results", `${label}.json`), JSON.stringify({ report, samples: Object.fromEntries(samples) }, null, 2));
  await writeFile(resolve(root, "results", `${label}.log`), servers.map((s, k) => s.log.map((l) => `[${k}] ${l}`).join("\n")).join("\n"));
  console.log(JSON.stringify(report, null, 2));
} finally {
  sampling = false;
  await sampler;
  await Promise.all(servers.map(stopServer));
  await db.end();
  await workflowDb.end();
}
