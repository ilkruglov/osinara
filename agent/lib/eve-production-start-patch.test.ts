/**
 * Eve production startup patch contract tests.
 *
 * Constructs covered:
 * - Patched Eve health timeout: permits bounded first-start sandbox initialization.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { codeShape } from "./vendored-code.js";

const PATCHED_HEALTH_TIMEOUT_MARKER = "const HEALTH_TIMEOUT_MS=3e5";

describe("Eve production startup patch", () => {
  it("allows five minutes for the built server to become healthy", async () => {
    const [evePackageSource, runtime] = await Promise.all([
      readFile("vendor/eve/package.json", "utf8"),
      readFile(
        "vendor/eve/dist/src/internal/nitro/host/start-production-server.js",
        "utf8",
      ),
    ]);
    const evePackage = JSON.parse(evePackageSource) as { version?: string };

    expect(evePackage.version).toBe("0.40.0");
    expect(codeShape(runtime)).toContain(codeShape(PATCHED_HEALTH_TIMEOUT_MARKER));
    expect(codeShape(runtime)).not.toContain(codeShape("const HEALTH_TIMEOUT_MS=6e4"));
  });
});
