/**
 * Eve compaction decision log patch tests.
 *
 * Constructs covered:
 * - `shouldCompact` reports threshold, last known input tokens and the estimate on every check.
 * - Every check names its session and turn.
 * - The patched compaction runtime stays syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const COMPACTION_PATH = "node_modules/eve/dist/src/harness/compaction.js";
const execFileAsync = promisify(execFile);

describe("Eve compaction decision log patch", () => {
  it("logs every compaction check with the numbers the decision used", async () => {
    const compaction = await readFile(COMPACTION_PATH, "utf8");

    // Prod sessions grew to 133k prompt tokens with a 120k threshold and no compaction event in
    // three days (10 сентября 2026); the decision inputs were invisible until this line.
    expect(compaction).toContain('code:"AGENT_COMPACTION_CHECK"');
    expect(compaction).toMatch(/function shouldCompact\(e,t,i\)\{[^}]*AGENT_COMPACTION_CHECK[^}]*threshold:t\.threshold/u);
    expect(compaction).not.toContain("function shouldCompact(e,t){return e.length>0&&");
  });

  it("names the session and turn of every check", async () => {
    const [compaction, toolLoop] = await Promise.all([
      readFile(COMPACTION_PATH, "utf8"),
      readFile("node_modules/eve/dist/src/harness/tool-loop.js", "utf8"),
    ]);
    // Without them a check was matched to model steps by log adjacency, which parallel sessions
    // interleave (25 сентября 2026: two separate analyses of the same week had to guess).
    expect(compaction).toMatch(/function shouldCompact\(e,t,i\)\{[^}]*sessionId:i\?\.sessionId\?\?null,turnId:i\?\.turnId\?\?null/u);
    expect(toolLoop).toContain("shouldCompact(r,i.compaction,{sessionId:i.sessionId,turnId:n.turnId})");
  });

  it("keeps the patched compaction runtime syntactically valid", async () => {
    await expect(execFileAsync(process.execPath, ["--check", COMPACTION_PATH])).resolves.toMatchObject({
      stderr: "",
    });
  });
});
