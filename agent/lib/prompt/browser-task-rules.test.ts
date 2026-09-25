/** The browser_task routing sentence reaches the model only while the tool is offered. */
import { describe, expect, it } from "vitest";

import { modeInstructions } from "./mode-instructions.js";

describe("browser_task routing rules", () => {
  it.each(["private", "family"] as const)("are absent in %s mode without the tool", (environment) => {
    expect(modeInstructions({ environment })).not.toContain("browser_task");
  });

  it.each(["private", "family"] as const)("route site actions in %s mode with the tool", (environment) => {
    const block = modeInstructions({ browserTask: true, environment });
    expect(block).toContain("через `browser_task`");
    // The status contract lives in the tool descriptor, not in every model step.
    expect(block).not.toContain("save_field");
  });
});
