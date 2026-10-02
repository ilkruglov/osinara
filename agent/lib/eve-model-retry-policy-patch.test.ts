/**
 * Eve model-call retry policy patch tests.
 *
 * Constructs covered:
 * - Eve delegates bounded transport retries to AI SDK 7's stable default.
 * - Eve outer orchestration never reissues a completed or partially observed model step.
 * - Empty output and unsupported provider tools propagate without a second paid call.
 * - Compaction fails rather than issuing a second summary model call.
 * - Dependency pins satisfy Eve 0.40.0's AI SDK 7 peer contract.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { codeShape } from "./vendored-code.js";

const TOOL_LOOP_PATH = "vendor/eve/dist/src/harness/tool-loop.js";
const COMPACTION_PATH = "vendor/eve/dist/src/harness/compaction.js";
const execFileAsync = promisify(execFile);

describe("Eve model retry policy patch", () => {
  it("pins Eve and compatible AI SDK packages exactly", async () => {
    const packageSource = await readFile("package.json", "utf8");
    const packageJson = JSON.parse(packageSource) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };

    expect(packageJson.dependencies).toMatchObject({
      "@ai-sdk/anthropic": "4.0.37",
      "@ai-sdk/groq": "4.0.27",
      "@ai-sdk/openai-compatible": "3.0.29",
      "@googleworkspace/cli": "0.22.5",
      ai: "7.0.60",
      eve: "file:vendor/eve",
    });
    expect(packageJson.overrides.ai).toBe("7.0.60");
    // Workflow step ids are `step//eve@<version>//<name>`: a changed version strands every
    // in-flight run, so the fork keeps the upstream name and version.
    const vendored = JSON.parse(await readFile("vendor/eve/package.json", "utf8")) as { name: string; version: string };
    expect(vendored).toMatchObject({ name: "eve", version: "0.40.0" });
  });

  it("delegates transport retries to AI SDK while disabling Eve-level reissues", async () => {
    const [runtime, compaction, aiRuntime] = await Promise.all([
      readFile(TOOL_LOOP_PATH, "utf8"),
      readFile(COMPACTION_PATH, "utf8"),
      readFile("node_modules/ai/dist/index.js", "utf8"),
    ]);

    // AI SDK 7 owns its documented two-retry transport default; Eve must not override it.
    expect(codeShape(runtime)).not.toContain(codeShape("AI_SDK_TRANSPORT_MAX_RETRIES"));
    expect(aiRuntime).toContain("maxRetries = 2");
    expect(runtime).not.toMatch(/ToolLoopAgent\([^)]*maxRetries/u);
    expect(compaction).not.toMatch(/generateText\([^)]*maxRetries/u);
    // Stable function names and log messages survive Eve's package build and guard semantic reissues.
    expect(codeShape(runtime)).toContain(codeShape("async function runModelCallWithRetries"));
    expect(codeShape(runtime)).toContain(codeShape("async function attemptEmptyResponseRecovery"));
    expect(codeShape(runtime)).toContain(codeShape("async function attemptUnsupportedProviderToolRecovery"));
    expect(codeShape(runtime)).not.toContain(codeShape("model call failed transiently — retrying"));
    // An empty model response has no side effect to duplicate, so Eve's single nudge-and-reissue
    // stays: without it a reasoning-only reply parks the whole session for the user.
    expect(codeShape(runtime)).toContain(codeShape("reissuing the model call once"));
    expect(codeShape(runtime)).not.toContain(codeShape("async function attemptEmptyResponseRecovery(e){return{outcome:`skipped`}}"));
    expect(codeShape(runtime)).not.toContain(codeShape("disabling unsupported provider tool(s); retrying step once"));
    // Compaction never buys a second summary call: an oversized summary is returned and logged.
    expect(codeShape(compaction)).not.toContain(codeShape("||m===0)return v;--m"));
    expect(codeShape(compaction)).toContain(codeShape("AGENT_COMPACTION_OUTPUT_OVER_LIMIT"));
  });

  it("keeps every patched model runtime syntactically valid", async () => {
    for (const path of [TOOL_LOOP_PATH, COMPACTION_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({
        stderr: "",
      });
    }
  });
});
