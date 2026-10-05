/**
 * The agent's runtime import boundary.
 *
 * Constructs covered:
 * - No runtime module under agent/ imports a value from outside what the production image
 *   carries (agent/, config/, migrations/, package.json). The image has no scripts/ or services/
 *   sources, and Eve re-bundles authored modules from that tree at start: 1.8.25 imported
 *   scripts/eve-runtime/html-text.js from a tool and the agent could not start (5 October
 *   2026). Type-only imports are erased and allowed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(agentRoot, "..");
// What the runtime stage of the Dockerfile copies next to agent/.
const IMAGE_PATHS = ["agent", "config", "migrations", "package.json"].map((path) => resolve(projectRoot, path));

function inImage(target: string): boolean {
  return IMAGE_PATHS.some((path) => target === path || target.startsWith(path + sep));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

// Static `import … from`, `export … from` and dynamic `import("…")` of a relative specifier;
// `import type` / `export type` are erased by the bundler.
const IMPORT_PATTERN = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu;

describe("agent runtime import boundary", () => {
  it("imports no value from outside the paths the image carries", () => {
    const escapes: string[] = [];
    for (const file of sourceFiles(agentRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        if (match[2]) continue;
        const specifier = match[3] ?? match[4]!;
        const target = resolve(dirname(file), specifier);
        if (!inImage(target)) {
          escapes.push(`${relative(agentRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });
});
