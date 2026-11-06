/**
 * The Workflow Postgres pool and worker settings.
 *
 * Constructs covered:
 * - Absent settings keep the package defaults (no pool cap, fifty workers).
 * - Whole numbers in range are taken; anything else fails the start with a stable code instead of
 *   silently becoming something else (Codex review, 6 November 2026: -1 left no workers, 0 became
 *   fifty, "30oops" became thirty).
 */
import { describe, expect, it } from "vitest";

import { workflowPostgresSettings } from "./workflow-settings.js";

describe("workflowPostgresSettings", () => {
  it("keeps the package defaults when nothing is set", () => {
    expect(workflowPostgresSettings({})).toEqual({ maxPoolSize: undefined, queueConcurrency: 50 });
  });

  it("takes whole numbers in range", () => {
    expect(workflowPostgresSettings({ WORKFLOW_POSTGRES_MAX_POOL_SIZE: "32", WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "30" }))
      .toEqual({ maxPoolSize: 32, queueConcurrency: 30 });
  });

  it.each([
    ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "-1"],
    ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "0"],
    ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "30oops"],
    ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "1e3"],
    ["WORKFLOW_POSTGRES_MAX_POOL_SIZE", "0"],
    ["WORKFLOW_POSTGRES_MAX_POOL_SIZE", " 32"],
    ["WORKFLOW_POSTGRES_MAX_POOL_SIZE", "100000"],
  ])("refuses %s=%s", (name, value) => {
    expect(() => workflowPostgresSettings({ [name]: value })).toThrow("AGENT_RUNTIME_TUNING_INVALID");
  });

  it("treats an empty value as absent, as compose writes an unset variable", () => {
    expect(workflowPostgresSettings({ WORKFLOW_POSTGRES_MAX_POOL_SIZE: "", WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "" }))
      .toEqual({ maxPoolSize: undefined, queueConcurrency: 50 });
  });
});
