/**
 * Deploy waits for running turns before it stops the current release.
 *
 * Constructs covered:
 * - The active-run query counts a step in flight, a fresh pause between steps and a message the
 *   session is about to take, and ignores parked sessions, approval waits, finished and stuck runs.
 * - The drain stops the Telegram ingress worker first, pauses new turns (the webhook and the minute
 *   schedules could still start one), marks the services as stopped for the failure path, returns
 *   once nothing is active, and gives up at its ceiling.
 * - A drain that cannot read the running turns, or cannot pause new ones, cancels the deploy and
 *   lifts the pause (owner's decision, 7 November 2026); stopping the release lifts it too.
 * - Every poll is bounded by the remaining drain budget, on the host (docker exec) and in
 *   PostgreSQL (statement and lock timeouts); the claimed-work poll too (its own cases are in
 *   `scripts/production-deploy/drain-current-turns.test.ts`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./agent/lib/database.js";
import { TURN_START_LOCK_KEY_SQL } from "./agent/lib/deploy/turn-start-pause.js";

const scripts = fileURLToPath(new URL("scripts/production-deploy/", import.meta.url));
const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function controller(
  body: string,
  env: Record<string, string> = {},
  options: { allowFailure?: boolean } = {},
): { status: number; stderr: string; stdout: string } {
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
    return { status: 0, stderr: "", stdout };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string; stdout?: string };
    if (options.allowFailure)
      return {
        status: failed.status ?? 1,
        stderr: failed.stderr ?? "",
        stdout: failed.stdout ?? "",
      };
    throw new Error(`controller failed: ${failed.stderr ?? ""}${failed.stdout ?? ""}`);
  }
}

function runDrain(
  counts: string[],
  timeoutSeconds: number,
  options: { pauseFails?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "drain-"));
  writeFileSync(join(dir, "counts"), `${counts.join("\n")}\n`);
  const result = controller(`
    compose_current() { printf '%s\\n' "$*" >> "${dir}/compose"; }
    pause_new_turns() { printf 'pause\\n' >> "${dir}/compose"; ${options.pauseFails ? "return 1" : "return 0"}; }
    resume_new_turns() { printf 'resume\\n' >> "${dir}/compose"; }
    count_active_workflow_runs() {
      printf '%s\n' "$1" >> "${dir}/budgets"
      local next; next="$(head -n 1 "${dir}/counts")"; sed -i 1d "${dir}/counts"
      [[ "$next" == "error" ]] && return 1
      printf '%s\\n' "\${next:-0}"
    }
    count_claimed_turn_work() { printf '0\n'; }
    sleep() { :; }
    drain_current_turns ${timeoutSeconds} 2> "${dir}/log" && status=0 || status=$?
    echo "stopped=$CURRENT_SERVICES_STOPPED status=$status"
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

const LOG_ONLY_STDERR = { allowFailure: true };

describe("deploy turn drain", () => {
  it("stops ingress, pauses new turns and returns once no run is active", () => {
    const run = runDrain(["2", "1", "0", "5"], 300);
    expect(run.compose.trim().split("\n")).toEqual(["stop telegram-ingress-worker", "pause"]);
    expect(run.stdout).toContain("stopped=1 status=0");
    expect(run.log).toContain("DEPLOY_TURNS_DRAINED");
    expect(run.remaining.trim()).toBe("5");
  });

  // Owner's decision, 7 November 2026: a deploy that cannot tell whether turns run is cancelled.
  it("cancels the deploy and lifts the pause when the running turns cannot be read", () => {
    const run = runDrain(["error"], 300);
    expect(run.log).toContain("DEPLOY_TURN_DRAIN_UNAVAILABLE");
    expect(run.stdout).toContain("stopped=1 status=1");
    expect(run.compose.trim().split("\n")).toEqual([
      "stop telegram-ingress-worker",
      "pause",
      "resume",
    ]);
  });

  it("cancels the deploy when new turns cannot be paused", () => {
    const run = runDrain(["0"], 300, { pauseFails: true });
    expect(run.log).toContain("DEPLOY_TURN_PAUSE_FAILED");
    expect(run.stdout).toContain("status=1");
    expect(run.budgets).toEqual([""]);
  });

  it("pauses and lifts new turns with bounded SQL that skips a release without the pause table", () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-pause-"));
    controller(`
      CURRENT_ENV=/srv/release.env CURRENT_COMPOSE=/srv/compose.yaml
      timeout() { printf '%s\n' "$*" >> "${dir}/argv"; cat >> "${dir}/stdin"; }
      pause_new_turns
      resume_new_turns
    `);
    const argv = readFileSync(join(dir, "argv"), "utf8");
    const stdin = readFileSync(join(dir, "stdin"), "utf8");
    expect(argv).toMatch(/^--kill-after=5 20 docker compose --project-name osinara-production /u);
    expect(argv).toContain("--dbname osinara");
    expect(stdin).toContain("to_regclass('public.deploy_turn_pause')");
    expect(stdin).toContain("now() + interval '15 minutes'");
    expect(stdin).toContain("DELETE FROM deploy_turn_pause");
    // The claims' lock, taken alone, waited for up to 15 s (the claims run a few queries each).
    expect(stdin).toContain(`pg_advisory_xact_lock(${TURN_START_LOCK_KEY_SQL})`);
    expect(stdin).toContain("set_config('lock_timeout', '15s', true)");
  });

  it("lifts the pause once the release has stopped", () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-stop-"));
    const run = controller(
      `
      compose_current() { if [[ "$1" == "config" ]]; then printf 'agent\npostgres\ntelegram-ingress-worker\n'; else printf '%s\n' "$*" >> "${dir}/compose"; fi; }
      resume_new_turns() { printf 'resume\n' >> "${dir}/compose"; }
      stop_current_services
    `,
      {},
      LOG_ONLY_STDERR,
    );
    expect(run.status).toBe(0);
    expect(readFileSync(join(dir, "compose"), "utf8").trim().split("\n")).toEqual([
      "stop agent telegram-ingress-worker",
      "resume",
    ]);
  });

  it("gives up at its ceiling and lets the deploy continue", () => {
    const run = runDrain(["3", "3", "3"], 0);
    expect(run.log).toContain("DEPLOY_TURN_DRAIN_TIMEOUT");
    expect(run.log).toContain("3");
    expect(run.stdout).toContain("stopped=1 status=0");
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

  it("runs the claimed-work query against the application database under the same bounds", () => {
    const dir = mkdtempSync(join(tmpdir(), "drain-claimed-"));
    controller(`
      CURRENT_ENV=/srv/release.env CURRENT_COMPOSE=/srv/compose.yaml
      timeout() { printf '%s\n' "$*" > "${dir}/argv"; cat > "${dir}/stdin"; echo 0; }
      count_claimed_turn_work 20
    `);
    const argv = readFileSync(join(dir, "argv"), "utf8");
    const stdin = readFileSync(join(dir, "stdin"), "utf8");
    expect(argv).toMatch(/^--kill-after=5 20 docker compose --project-name osinara-production /u);
    expect(argv).toContain("--dbname osinara ");
    expect(stdin).toContain("SET statement_timeout = '20s';");
    expect(stdin).toContain("SET lock_timeout = '2s';");
    expect(stdin).toContain("FROM telegram_ingress_updates");
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
      [
        "step-in-flight",
        "running",
        [
          ["hook_created", "2 minutes"],
          ["step_started", "1 minute"],
        ],
      ],
      [
        "fresh-pause",
        "running",
        [
          ["step_started", "20 seconds"],
          ["step_completed", "1 second"],
        ],
      ],
      [
        "message-waiting",
        "running",
        [
          ["step_completed", "5 minutes"],
          ["hook_received", "2 minutes"],
        ],
      ],
      [
        "mid-step-attribute",
        "running",
        [
          ["step_started", "30 seconds"],
          ["attr_set", "10 seconds"],
        ],
      ],
      [
        "parked-session",
        "running",
        [
          ["hook_created", "3 minutes"],
          ["step_completed", "2 minutes"],
        ],
      ],
      [
        "approval-wait",
        "running",
        [
          ["step_completed", "2 minutes"],
          ["hook_created", "1 minute"],
        ],
      ],
      ["stuck", "running", [["step_started", "30 minutes"]]],
      ["finished", "completed", [["step_started", "1 minute"]]],
    ];
    for (const [id, status, events] of runs) {
      await database().query("INSERT INTO workflow.workflow_runs (id, status) VALUES ($1, $2)", [
        id,
        status,
      ]);
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
