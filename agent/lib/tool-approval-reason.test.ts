/**
 * Approval purpose coverage tests.
 *
 * Constructs covered:
 * - Every approval-gated tool accepts `approvalReason`, so no confirmation ships without a purpose.
 * - `approvalReasonSchema`: bounded optional display text.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { approvalReasonSchema } from "./tool-approval-reason.js";

const TOOLS_DIRECTORY = resolve(import.meta.dirname, "tools");

/** Own source plus one level of relative imports, because a schema may live in a contract module. */
function reachableSource(path: string): string {
  const source = readFileSync(path, "utf8");
  const imports = [...source.matchAll(/from "(\.[^"]+)\.js"/gu)].map((match) => match[1]!);
  return imports.reduce((text, relative) => {
    try {
      return text + readFileSync(resolve(dirname(path), `${relative}.ts`), "utf8");
    } catch {
      return text;
    }
  }, source);
}

function approvalGatedTools(): string[] {
  return readdirSync(TOOLS_DIRECTORY)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .filter((name) => /^\s*approval:/mu.test(readFileSync(resolve(TOOLS_DIRECTORY, name), "utf8")));
}

describe("approval purpose coverage", () => {
  it("finds the approval-gated tools", () => {
    // A drop to zero would make the assertion below pass vacuously.
    expect(approvalGatedTools().length).toBeGreaterThanOrEqual(14);
  });

  it.each(approvalGatedTools())("%s accepts an approval purpose", (name) => {
    expect(reachableSource(resolve(TOOLS_DIRECTORY, name))).toContain("approvalReasonSchema");
  });
});

describe("approvalReasonSchema", () => {
  it("accepts one bounded sentence and stays optional", () => {
    expect(approvalReasonSchema.safeParse(undefined).success).toBe(true);
    expect(approvalReasonSchema.safeParse("Вы просили очистить рассылки.").success).toBe(true);
    expect(approvalReasonSchema.safeParse("").success).toBe(false);
    expect(approvalReasonSchema.safeParse("я".repeat(301)).success).toBe(false);
  });
});
