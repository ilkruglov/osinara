/**
 * Eve model-call retry policy patch tests.
 *
 * Constructs covered:
 * - AI SDK performs two bounded transport retries for retryable provider failures.
 * - Eve outer orchestration never reissues a completed or partially observed model step.
 * - Empty output and unsupported provider tools propagate without a second paid call.
 * - Compaction and auxiliary Eve model surfaces use the same bounded transport policy.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const TOOL_LOOP_PATH = "node_modules/eve/dist/src/harness/tool-loop.js";
const COMPACTION_PATH = "node_modules/eve/dist/src/harness/compaction.js";
const AUTOEVAL_PATH = "node_modules/eve/dist/src/evals/autoevals-client.js";
const CODE_MODE_PATH =
  "node_modules/eve/dist/src/compiled/experimental-ai-sdk-code-mode/index.js";
const execFileAsync = promisify(execFile);

describe("Eve model retry policy patch", () => {
  it("allows transport retries but disables Eve-level reissues in the root tool loop", async () => {
    const runtime = await readFile(TOOL_LOOP_PATH, "utf8");

    expect(runtime).toContain(
      "new ToolLoopAgent({headers:B,instructions:i,maxRetries:2,model:L",
    );
    expect(runtime).toContain(
      "async function runModelCallWithRetries(e,t,n){throwIfTurnAborted(n);try{return await e(1)}catch(e){throwIfTurnAborted(n);throw e}}",
    );
    expect(runtime).toContain(
      "async function attemptEmptyResponseRecovery(e){return{outcome:`skipped`}}",
    );
    expect(runtime).toContain(
      "async function attemptUnsupportedProviderToolRecovery(e){return{outcome:`skipped`}}",
    );
    expect(runtime).not.toContain("model call failed transiently — retrying");
    expect(runtime).not.toContain("reissuing the model call once");
    expect(runtime).not.toContain("disabling unsupported provider tool(s); retrying step once");
  });

  it("allows two transport retries on every auxiliary Eve model surface", async () => {
    const [compaction, autoeval, codeMode] = await Promise.all([
      readFile(COMPACTION_PATH, "utf8"),
      readFile(AUTOEVAL_PATH, "utf8"),
      readFile(CODE_MODE_PATH, "utf8"),
    ]);

    expect(compaction).toContain("generateText({abortSignal:c,headers:s,maxRetries:2,model:r");
    expect(compaction).toContain("EVE_COMPACTION_OUTPUT_TOO_LARGE");
    expect(compaction).not.toContain("return g;--l");
    expect(autoeval).toContain("generateText({maxRetries:2,model:n.languageModel,messages:");
    expect(codeMode).toContain("await n({...e,maxRetries:2})");
    expect(codeMode).toContain("i({...e,maxRetries:2})");
  });

  it("keeps every patched model runtime syntactically valid", async () => {
    for (const path of [TOOL_LOOP_PATH, COMPACTION_PATH, AUTOEVAL_PATH, CODE_MODE_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({
        stderr: "",
      });
    }
  });
});
