/**
 * The skill lab's tool surface against Eve's framework defaults.
 *
 * Constructs covered:
 * - Every tool Eve registers in an agent by default, and every default exported from
 *   `eve/tools/defaults`, has a file in the lab's tools directory that either disables it or
 *   wraps it deliberately. The lab runs inside the agent container with a bash backend that has
 *   full network access (security audit, 6 October 2026, N-1): an executing tool that slipped
 *   through would read the container's files or reach the app network and the internet past the
 *   egress stack. `read_file` had no file at all until this test.
 * - The disabling files are exactly `disableTool()`, so a later edit cannot quietly re-enable one.
 */
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const LAB_TOOLS = "services/skill-lab/agent/tools";
const FRAMEWORK_TOOLS = "vendor/eve/dist/src/runtime/framework-tools/index.js";
const DEFAULTS = "vendor/eve/dist/src/public/tools/defaults.js";

/** The lab's own executors: a wrapped default or a scenario double, never a real executor. */
const DELIBERATE = new Set(["write_file", "scenario"]);

async function toolNames(path: string): Promise<string[]> {
  const source = await readFile(path, "utf8");
  const names = new Set<string>();
  for (const [, file] of source.matchAll(/#runtime\/framework-tools\/([a-z-]+)\.js/gu)) {
    if (!["file-state", "todo", "skill", "tasks"].includes(file)) names.add(file.replaceAll("-", "_"));
  }
  if (source.includes("TASK_TOOL_DEFINITIONS")) for (const task of ["task_cancel", "task_sleep", "task_update"]) names.add(task);
  if (source.includes("TODO_TOOL_DEFINITION")) names.add("todo");
  if (source.includes("SKILL_TOOL_DEFINITION")) names.add("load_skill");
  return [...names].sort();
}

describe("skill lab tool surface", () => {
  it("disables or deliberately wraps every framework default tool", async () => {
    const framework = await toolNames(FRAMEWORK_TOOLS);
    const defaults = await toolNames(DEFAULTS);
    // `load_skill` is the lab's purpose and is routed through the scenario tool; the connection
    // search only searches connections the application registered, and the lab registers none.
    const labAgent = await readFile("services/skill-lab/agent/agent.ts", "utf8");
    expect(labAgent).not.toMatch(/connections\s*:/u);
    const expected = [...new Set([...framework, ...defaults])]
      .filter((name) => name !== "load_skill" && name !== "connection_search_dynamic").sort();
    const present = (await readdir(LAB_TOOLS)).filter((file) => file.endsWith(".ts")).map((file) => file.slice(0, -3)).sort();

    // Everything Eve would hand the lab's model has a file here; `load_skill` is the lab's
    // purpose and is routed through the scenario tool instead.
    expect(expected.filter((name) => !present.includes(name))).toEqual([]);
    expect(expected).toContain("read_file");
    expect(expected).toContain("bash");
    expect(expected).toContain("web_fetch");
    expect(expected).toContain("web_search");

    for (const name of present) {
      const source = await readFile(`${LAB_TOOLS}/${name}.ts`, "utf8");
      if (DELIBERATE.has(name)) continue;
      expect(source, name).toMatch(/import \{ disableTool \} from "eve\/tools";\s*export default disableTool\(\);\s*$/u);
    }
  });
});
