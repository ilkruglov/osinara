/**
 * The agent's runtime import boundary.
 *
 * Constructs covered:
 * - No runtime module under agent/ pulls in a file the production image does not carry (it
 *   carries agent/, config/, migrations/ and package.json, no scripts/ or services/ sources).
 *   Eve re-bundles authored modules from that tree at start: 1.8.25 imported
 *   scripts/eve-runtime/html-text.js from a tool and the agent could not start (5 October 2026).
 * - The check bundles every runtime module with esbuild, as Eve's bundler would, and reads the
 *   files the bundle actually took, so every form is seen: static, side-effect and dynamic
 *   imports, re-exports and `require()`, with types erased. A missing file fails the bundle; a
 *   dynamic import or require of a computed specifier is refused, since nothing can check it
 *   (Codex review, 5 October 2026).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(agentRoot, "..");
// What the runtime stage of the Dockerfile copies next to agent/.
const IMAGE_PATHS = ["agent", "config", "migrations", "package.json"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

/** Files outside the image the bundle of `entries` takes, computed imports, and bundle errors. */
async function boundaryProblems(root: string, entries: readonly string[], imagePaths: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [...entries],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    outdir: join(root, ".boundary-out"),
    packages: "external",
    platform: "node",
    write: false,
  }).catch((error: { errors?: Array<{ location?: { file: string; line: number } | null; text: string }> }) => {
    for (const message of error.errors ?? []) {
      problems.push(`${message.location?.file ?? "?"}:${message.location?.line ?? "?"} ${message.text}`);
    }
    return null;
  });
  if (!result) return problems;
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!imagePaths.some((path) => input === path || input.startsWith(`${path}/`))) {
      problems.push(`${input} is bundled but not in the image`);
    }
  }
  for (const output of result.outputFiles) {
    // esbuild keeps a computed `import(x)` and turns a computed `require(x)` into `__require(x)`.
    for (const match of output.text.matchAll(/\b(?:import|__require)\(\s*(?!["'`])([^)]{0,60})/gu)) {
      problems.push(`${relative(root, output.path)} imports a computed specifier: ${match[1]}`);
    }
  }
  return problems;
}

describe("agent runtime import boundary", () => {
  it("bundles no file the image does not carry", async () => {
    const entries = sourceFiles(agentRoot).map((file) => relative(projectRoot, file));
    expect(await boundaryProblems(projectRoot, entries, IMAGE_PATHS)).toEqual([]);
  }, 60_000);

  it("sees every import form, missing files and computed specifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "osinara-boundary-"));
    try {
      mkdirSync(join(root, "agent"));
      mkdirSync(join(root, "scripts"));
      const write = (path: string, text: string) => writeFileSync(join(root, path), text);
      write("scripts/side.ts", "export const side = 1;");
      write("scripts/star.ts", "export const star = 1;");
      write("scripts/dynamic.ts", "export const dynamic = 1;");
      write("scripts/required.cjs", "module.exports = 1;");
      write("scripts/types.ts", "export type T = number;");
      write("agent/side-effect.ts", "import \"../scripts/side.js\";");
      write("agent/star.ts", "export * from \"../scripts/star.js\";");
      write("agent/dynamic.ts", "export const load = () => import(/* why */ \"../scripts/dynamic.js\");");
      write("agent/required.ts", "export const value = require(\"../scripts/required.cjs\");");
      write("agent/type-only.ts", "import type { T } from \"../scripts/types.js\"; export const t: T = 1;");
      write("agent/computed.ts", "export const load = (name: string) => import(name);");
      const problems = await boundaryProblems(root, readdirSync(join(root, "agent")).map((file) => `agent/${file}`), ["agent"]);
      expect(problems.filter((problem) => problem.includes("not in the image")).sort()).toEqual([
        "scripts/dynamic.ts is bundled but not in the image",
        "scripts/required.cjs is bundled but not in the image",
        "scripts/side.ts is bundled but not in the image",
        "scripts/star.ts is bundled but not in the image",
      ]);
      expect(problems.some((problem) => problem.includes("computed specifier: name"))).toBe(true);

      write("agent/missing.ts", "import \"./nowhere.js\";");
      const missing = await boundaryProblems(root, ["agent/missing.ts"], ["agent"]);
      expect(missing.join("\n")).toMatch(/nowhere\.js/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
