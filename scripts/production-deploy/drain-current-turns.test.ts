/**
 * The deploy's wait for running turns (backup.sh, `drain_current_turns`), run in bash with the
 * database polls stubbed.
 *
 * Constructs covered:
 * - The wait ends only when there is neither a Workflow run in flight nor work claimed from the
 *   application database that is not a run yet (/code-review of 1.8.57–1.8.58: a claim made just
 *   before the pause was invisible to the Workflow count, and the stop cut it). The claimed work is
 *   read first, so work that becomes a run between the two reads is in the second. A claim still in
 *   its transaction cannot be missed: the pause waits for it (turn-start-pause.integration.test.ts).
 * - A poll of the claimed work that fails cancels the deploy and lifts the pause, as a failed
 *   Workflow poll does.
 * - At the ceiling the deploy goes on and the log names both counts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BACKUP_SH = join(import.meta.dirname, "backup.sh");

/** Runs one drain; each poll takes the next value of its list, `fail` makes that poll fail. */
function drain(input: { active: string[]; claimed: string[]; timeout?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "osinara-drain-"));
  writeFileSync(join(dir, "active"), `${input.active.join("\n")}\n`);
  writeFileSync(join(dir, "claimed"), `${input.claimed.join("\n")}\n`);
  const script = `
    set -euo pipefail
    DIR=${JSON.stringify(dir)}
    source ${JSON.stringify(BACKUP_SH)}
    next_value() {
      local value
      value="$(head -n 1 "$1")"
      sed -i '1d' "$1"
      echo poll >> "$1.polls"
      [[ "$value" != fail ]] || return 1
      printf '%s' "$value"
    }
    compose_current() { :; }
    pause_new_turns() { :; }
    resume_new_turns() { echo RESUMED; }
    log_event() { echo "EVENT $1 $2"; }
    sleep() { :; }
    count_active_workflow_runs() { echo active >> "$DIR/order"; next_value "$DIR/active"; }
    count_claimed_turn_work() { echo claimed >> "$DIR/order"; next_value "$DIR/claimed"; }
    status=0
    drain_current_turns ${input.timeout ?? 300} || status=$?
    echo "STATUS $status"
  `;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const polls = (name: string) => {
    try {
      return readFileSync(join(dir, `${name}.polls`), "utf8")
        .trim()
        .split("\n").length;
    } catch {
      return 0;
    }
  };
  let order: string[] = [];
  try {
    order = readFileSync(join(dir, "order"), "utf8").trim().split("\n");
  } catch {
    order = [];
  }
  return { claimedPolls: polls("claimed"), order, out: `${result.stdout}${result.stderr}` };
}

describe("drain_current_turns", () => {
  it("waits while claimed work has no Workflow run yet, then ends", () => {
    const result = drain({ active: ["0", "0"], claimed: ["1", "0"] });

    expect(result.out).toContain("EVENT DEPLOY_TURNS_DRAINED");
    expect(result.out).toContain("STATUS 0");
    expect(result.claimedPolls).toBe(2);
  });

  // /code-review of the drain fix, 9 November 2026: read after the runs, a claim that became a run
  // between the two reads was in neither count.
  it("reads the claimed work before the Workflow runs in every poll", () => {
    const result = drain({ active: ["1", "0"], claimed: ["0", "0"] });

    expect(result.order).toEqual(["claimed", "active", "claimed", "active"]);
  });

  it("cancels the deploy and lifts the pause when the claimed work cannot be read", () => {
    const result = drain({ active: [], claimed: ["fail"] });

    expect(result.out).toContain(
      "EVENT DEPLOY_TURN_DRAIN_UNAVAILABLE Could not read the claimed work",
    );
    expect(result.out).toContain("RESUMED");
    expect(result.out).toContain("STATUS 1");
  });

  it("goes on at the ceiling and names both counts", () => {
    const result = drain({ active: ["0"], claimed: ["2"], timeout: 0 });

    expect(result.out).toContain(
      "EVENT DEPLOY_TURN_DRAIN_TIMEOUT 0 Workflow runs and 2 claimed items still active",
    );
    expect(result.out).toContain("STATUS 0");
  });
});
