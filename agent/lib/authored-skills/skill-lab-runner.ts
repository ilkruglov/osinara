/** One immutable job per short-lived Eve process. No application credentials or filesystem mounts. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "eve/client";
import type { LabJob } from "../../../services/skill-lab/agent/lib/job.js";
import { experimentHash } from "./skill-experiment.js";

export interface LabResult {
  status: "completed" | "interrupted";
  passed: boolean[];
  artifactHashes: Record<string, string>;
  telemetry: Record<string, unknown>;
}
export async function runSkillLab(job: LabJob, signal: AbortSignal, options: { root?: string; deadlineAt?: number; diagnostic?: (text: string) => void } = {}): Promise<LabResult> {
  const root = options.root ?? process.cwd();
  const start = Date.now();
  await mkdir(resolve(root, ".tmp"), { recursive: true });
  const dir = await mkdtemp(resolve(root, ".tmp/skill-lab-"));
  const reportPath = resolve(dir, "journal.jsonl");
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined;
  let completed = false;
  let diagnostic = "";
  let stderr = "";
  try {
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((done, fail) => portServer.close((e) => e ? fail(e) : done()));
    const token = randomBytes(32).toString("hex");
    await writeFile(resolve(dir, "job.json"), JSON.stringify({ ...job, deadlineAt: Math.min(options.deadlineAt ?? Infinity, start + 90_000) }), { mode: 0o600 });
    await writeFile(resolve(dir, "package.json"), '{"name":"mia-skill-lab-run","type":"module","private":true}');
    await symlink(resolve(root, "node_modules"), resolve(dir, "node_modules"), "dir");
    child = spawn(process.execPath, [resolve(root, "services/skill-lab/.output/server/index.mjs")], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
        MODEL_API_KEY: process.env.MODEL_API_KEY, SKILL_LAB_TOKEN: token,
        SKILL_LAB_JOB: resolve(dir, "job.json"), SKILL_LAB_JOURNAL: reportPath },
    });
    childClosed = new Promise((done) => child!.once("close", () => done()));
    // Bound diagnostics, keep them local. Provider output and holdout text never reach the author.
    child.stderr?.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-4000); });
    child.stdout?.on("data", () => {});
    child.on("error", () => { diagnostic = "AGENT_SKILL_LAB_SPAWN_FAILED"; });
    const kill = () => { child?.kill("SIGKILL"); };
    signal.addEventListener("abort", kill, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("AGENT_SKILL_LAB_EXITED");
        try {
          const health = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) });
          if (health.ok) break;
        } catch { /* Wait for local listener, within the batch deadline. */ }
        if (Date.now() - start > 20_000) throw new Error("AGENT_SKILL_LAB_START_TIMEOUT");
        await delay(100, undefined, { signal });
      }
      const client = new Client({ host: `http://127.0.0.1:${port}`, auth: { basic: { username: "lab", password: token } } });
      const { response } = await client.sessions.create({ message: job.testCase.request, signal });
      const result = await response.result();
      completed = result.status !== "failed" && result.events.some((e) => e.type === "turn.completed");
      if (!completed) options.diagnostic?.(JSON.stringify(result.events.filter((e) => e.type.includes("failed"))) + "\n" + stderr);
    } finally { signal.removeEventListener("abort", kill); }
  } catch (error) {
    diagnostic = error instanceof Error ? error.message.split("\n")[0]! : "AGENT_SKILL_LAB_FAILED";
    options.diagnostic?.(diagnostic + "\n" + stderr);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await childClosed;
  }
  try {
    let journal: { kind: string; role?: string; usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } }; passed?: boolean[]; hashes?: Record<string, string>; sessionId?: string; turnId?: string }[] = [];
    try { journal = (await readFile(reportPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { completed = false; }
    const final = journal.find((r) => r.kind === "result");
    const loaded = !job.skill || journal.some((r) => r.kind === "loaded");
    const usages = journal.filter((r) => r.kind === "usage");
    const calls = journal.filter((r) => r.kind === "call").length;
    const coverageComplete = !journal.some((r) => r.kind === "uncovered");
    return { status: completed && final && coverageComplete ? "completed" : "interrupted",
      passed: final?.passed?.map((p) => p && loaded) ?? [], artifactHashes: final?.hashes ?? {},
      telemetry: { calls, judgeCalls: journal.filter((r) => r.kind === "call" && r.role === "judge").length,
        evidenceScope: job.environment === "scenario" ? "simulated_tools" : "isolated_files",
        simulatedCalls: journal.filter((r) => r.kind === "simulated").length, coverageComplete,
        toolContractsHash: experimentHash(job.toolContracts ?? {}),
        inputTokens: usages.reduce((n, r) => n + (r.usage?.inputTokens?.total ?? 0), 0),
        outputTokens: usages.reduce((n, r) => n + (r.usage?.outputTokens?.total ?? 0), 0),
        usageComplete: usages.length === calls && usages.every((u) => u.usage?.inputTokens?.total !== undefined && u.usage.outputTokens?.total !== undefined),
        durationMs: Date.now() - start, loaded, sessionId: final?.sessionId, turnId: final?.turnId,
        // Error bodies may contain model text. A bounded code conveys failure without leaking it.
        diagnostic: !coverageComplete ? "scenario_uncovered" : completed && final ? undefined : signal.aborted ? "cancelled_or_timed_out" : diagnostic.startsWith("AGENT_SKILL_LAB_") ? diagnostic : "runtime_failed" } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
