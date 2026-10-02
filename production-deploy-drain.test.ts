/**
 * Deploy waits for running turns before it stops the current release.
 *
 * Constructs covered:
 * - The active-run query counts a step in flight, a fresh pause between steps and a message the
 *   session is about to take, and ignores parked sessions, approval waits, finished and stuck runs.
 * - The drain stops the Telegram ingress worker first, marks the services as stopped for the
 *   failure path, returns once nothing is active, and gives up at its ceiling.
 * - A missing Workflow database does not stop the deploy.
 * - Every poll is bounded by the remaining drain budget, on the host (docker exec) and in
 *   PostgreSQL (statement and lock timeouts).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./agent/lib/database.js";

const scripts = fileURLToPath(new URL("scripts/production-deploy/", import.meta.url));
const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

function controller(body: string, env: Record<string, string> = {}): { stderr: string; stdout: string } {
  const script = `
    set -euo pipefail
    source "${scripts}common.sh"
    source "${scripts}database.sh"
    source "${scripts}backup.sh"
    ${body}
  `;
  try {
    const stdout = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stderr: "", stdout };
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };
    throw new Error(`controller failed: ${failed.stderr ?? ""}${failed.stdout ?? ""}`);
  }
}

function runDrain(counts: string[], timeoutSeconds: number) {
  const dir = mkdtempSync(join(tmpdir(), "drain-"));
  writeFileSync(join(dir, "counts"), `${counts.join("\n")}\n`);
  const result = controller(`
    compose_current() { printf '%s\\n' "$*" >> "${dir}/compose"; }
    count_active_workflow_runs() {
      printf '%s\n' "$1" >> "${dir}/budgets"
      local next; next="$(head -n 1 "${dir}/counts")"; sed -i 1d "${dir}/counts"
      [[ "$next" == "error" ]] && return 1
      printf '%s\\n' "\${next:-0}"
    }
    sleep() { :; }
    drain_current_turns ${timeoutSeconds} 2> "${dir}/log"
    echo "stopped=$CURRENT_SERVICES_STOPPED"
  `);
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    budgets: read("budgets").trim().split("\n"),
    compose: read("compose"),
    log: read("log"),
    remaining: read("counts"),
    stdout: result.stdout,
  };
}

describe("deploy turn drain", () => {
  it("stops ingress first and returns once no run is active", () => {
    const run = runDrain(["2", "1", "0", "5"], 300);
    expect(run.compose.trim()).toBe("stop telegram-ingress-worker");
    expect(run.stdout).toContain("stopped=1");
    expect(run.log).toContain("DEPLOY_TURNS_DRAINED");
    expect(run.remaining.trim()).toBe("5");
  });

  it("gives up at its ceiling and lets the deploy continue", () => {
    const run = runDrain(["3", "3", "3"], 0);
    expect(run.log).toContain("DEPLOY_TURN_DRAIN_TIMEOUT");
    expect(run.log).toContain("3");
    expect(run.stdout).toContain("stopped=1");
  });

  it("bounds every poll by what is left of the drain budget", () => {
    expect(runDrain(["1", "0"], 300).budgets).toEqual(["20", "20"]);
    const short = runDrain(["1", "0"], 7);
    expect(Number(short.budgets[0])).toBeLessThanOrEqual(7);
    expect(Number(short.budgets[0])).toBeGreaterThan(0);
  });

  it("runs the query under a host timeout and PostgreSQL statement and lock timeouts", () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-query-"));
    controller(`
      CURRENT_ENV=/srv/release.env CURRENT_COMPOSE=/srv/compose.yaml
      timeout() { printf '%s\n' "$*" > "${dir}/argv"; cat > "${dir}/stdin"; echo 0; }
      count_active_workflow_runs 20
    `);
    const argv = readFileSync(join(dir, "argv"), "utf8");
    const stdin = readFileSync(join(dir, "stdin"), "utf8");
    expect(argv).toMatch(/^--kill-after=5 20 docker compose --project-name osinara-production /u);
    expect(argv).toContain("exec -T postgres psql");
    expect(argv).toContain("--dbname osinara_workflow");
    expect(stdin).toContain("SET statement_timeout = '20s';");
    expect(stdin).toContain("SET lock_timeout = '2s';");
    expect(stdin).toContain("FROM workflow.workflow_runs AS run");
  });

  it("continues without a readable Workflow database", () => {
    const run = runDrain(["error"], 300);
    expect(run.log).toContain("DEPLOY_TURN_DRAIN_UNAVAILABLE");
    expect(run.stdout).toContain("stopped=1");
  });
});

describeWithDatabase("active workflow run query", () => {
  afterAll(async () => {
    await database().query("DROP SCHEMA IF EXISTS workflow CASCADE");
    await closeDatabase();
  });

  it("counts only runs that are doing work right now", async () => {
    const sql = controller("active_workflow_runs_sql").stdout;
    await database().query("DROP SCHEMA IF EXISTS workflow CASCADE");
    await database().query(`
      CREATE SCHEMA workflow;
      CREATE TABLE workflow.workflow_runs (id varchar PRIMARY KEY, status varchar NOT NULL);
      CREATE TABLE workflow.workflow_events (
        id varchar NOT NULL, type varchar NOT NULL, run_id varchar NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(), PRIMARY KEY (run_id, id)
      );
    `);
    const runs: Array<[string, string, Array<[string, string]>]> = [
      ["step-in-flight", "running", [["hook_created", "2 minutes"], ["step_started", "1 minute"]]],
      ["fresh-pause", "running", [["step_started", "20 seconds"], ["step_completed", "1 second"]]],
      ["message-waiting", "running", [["step_completed", "5 minutes"], ["hook_received", "2 minutes"]]],
      ["mid-step-attribute", "running", [["step_started", "30 seconds"], ["attr_set", "10 seconds"]]],
      ["parked-session", "running", [["hook_created", "3 minutes"], ["step_completed", "2 minutes"]]],
      ["approval-wait", "running", [["step_completed", "2 minutes"], ["hook_created", "1 minute"]]],
      ["stuck", "running", [["step_started", "30 minutes"]]],
      ["finished", "completed", [["step_started", "1 minute"]]],
    ];
    for (const [id, status, events] of runs) {
      await database().query("INSERT INTO workflow.workflow_runs (id, status) VALUES ($1, $2)", [id, status]);
      for (const [index, [type, age]] of events.entries()) {
        await database().query(
          `INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
           VALUES ($1, $2, $3, LOCALTIMESTAMP - $4::interval)`,
          [`evnt_${index}`, type, id, age],
        );
      }
    }
    const result = await database().query<{ count: string }>(sql);
    expect(Number(Object.values(result.rows[0]!)[0])).toBe(4);
  });
});
