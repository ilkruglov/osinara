/**
 * The vendored Workflow world reads its pool and worker settings strictly (vendored
 * `@workflow/world-postgres`, `dist/index.js`; logic in `scripts/eve-runtime/workflow-settings.ts`).
 *
 * Construct covered:
 * - Both settings come from `workflowPostgresSettings` and no `parseInt` of them is left (Codex
 *   review, 6 November 2026: -1 left no workers, 0 became fifty, "30oops" became thirty).
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { codeText } from "./vendored-code.js";

describe("Workflow Postgres settings", () => {
  it("reads the pool cap and the worker count through the strict reader only", async () => {
    const code = codeText(await readFile(new URL("../../vendor/workflow-world-postgres/dist/index.js", import.meta.url), "utf8"));

    expect(code).toContain(codeText('import { workflowPostgresSettings } from "./osinara-workflow-settings.js";'));
    expect(code).toContain(codeText("return workflowPostgresSettings().maxPoolSize;"));
    expect(code).toContain(codeText("queueConcurrency: workflowPostgresSettings().queueConcurrency,"));
    expect(code).not.toContain("parseInt(");
  });
});
