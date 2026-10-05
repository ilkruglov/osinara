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
 *   imports, re-exports and `require()`, with types erased; asset imports (any non-code file,
 *   `?raw` or not) are resolved like Eve's asset plugin does. A missing file fails the bundle; a
 *   dynamic import or require of a computed specifier is refused, since nothing can check it; a
 *   package must be a production dependency, since the image installs without dev ones (Codex
 *   reviews, 5 October 2026).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";
import { init as initLexer, parse as lexImports } from "es-module-lexer";
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

// Eve's authored-asset plugin turns any import of a non-code file into a module (text for
// `?raw`, a data URL otherwise); the boundary sees those files the same way.
const CODE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".json", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const BUILTINS = new Set(builtinModules);

function assetPlugin(problems: string[], root: string, imagePaths: readonly string[]): Plugin {
  return {
    name: "eve-authored-assets",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        const path = args.path.replace(/\?[a-z]+$/u, "");
        if (CODE_EXTENSIONS.has(extname(path)) || extname(path) === "") return undefined;
        const absolute = resolve(args.resolveDir, path);
        const where = relative(root, absolute);
        if (!existsSync(absolute)) problems.push(`${where} (asset) does not exist`);
        else if (!imagePaths.some((image) => where === image || where.startsWith(`${image}/`))) {
          problems.push(`${where} (asset) is not in the image`);
        }
        return { namespace: "eve-asset", path: absolute };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "eve-asset" }, () => ({ contents: "export default \"\";", loader: "js" }));
    },
  };
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Files outside the image the bundle of `entries` takes, computed imports, and bundle errors. */
async function boundaryProblems(
  root: string,
  entries: readonly string[],
  imagePaths: readonly string[],
  dependencies: ReadonlySet<string>,
): Promise<string[]> {
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
    plugins: [assetPlugin(problems, root, imagePaths)],
    write: false,
  }).catch((error: { errors?: Array<{ location?: { file: string; line: number } | null; text: string }>; message?: string }) => {
    // A failure without esbuild messages (a plugin or option error) must not read as a pass.
    if (!error.errors?.length) problems.push(`bundle failed: ${error.message ?? String(error)}`);
    for (const message of error.errors ?? []) {
      problems.push(`${message.location?.file ?? "?"}:${message.location?.line ?? "?"} ${message.text}`);
    }
    return null;
  });
  if (!result) return problems;
  for (const [input, { imports }] of Object.entries(result.metafile.inputs)) {
    if (input.startsWith("eve-asset:")) continue;
    if (!imagePaths.some((path) => input === path || input.startsWith(`${path}/`))) {
      problems.push(`${input} is bundled but not in the image`);
    }
    for (const imported of imports) {
      // A relative external is a type-only import esbuild erased, `<runtime>` its own helpers;
      // node: and bare builtins ship with Node.
      if (!imported.external || /^[./<]/u.test(imported.path) || imported.path.startsWith("node:") ||
        BUILTINS.has(imported.path)) continue;
      const name = packageName(imported.path);
      if (!dependencies.has(name)) problems.push(`${input} imports ${name}, which is not a production dependency`);
    }
  }
  await initLexer;
  for (const output of result.outputFiles) {
    const where = relative(root, output.path);
    // The lexer skips strings and comments; a dynamic import without a literal specifier has none.
    const [imports] = lexImports(output.text);
    for (const entry of imports) {
      if (entry.d > -1 && entry.n === undefined) {
        problems.push(`${where} imports a computed specifier: ${output.text.slice(entry.ss, entry.se)}`);
      }
    }
    // esbuild leaves a require it cannot bundle as `__require(…)`; only a lone string is checkable.
    for (const match of output.text.matchAll(/\b__require\(([^)]{0,80})\)/gu)) {
      // The helper's own definition mentions `__require()` with no argument.
      if (match[1]!.trim() !== "" && !/^\s*("[^"\\]*"|'[^'\\]*')\s*$/u.test(match[1]!)) {
        problems.push(`${where} requires a computed specifier: ${match[1]}`);
      }
    }
  }
  return problems;
}

const productionDependencies = new Set(Object.keys(
  (JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies,
));

describe("agent runtime import boundary", () => {
  it("bundles no file the image does not carry", async () => {
    // The authored modules Eve loads (agent.ts, sandbox.ts and the convention directories); the
    // library under agent/lib is checked as far as they reach it, so test helpers stay out.
    const entries = [
      ...["agent.ts", "sandbox.ts"].map((file) => join(agentRoot, file)),
      ...["channels", "hooks", "instructions", "schedules", "skills", "subagents", "tools"]
        .flatMap((directory) => existsSync(join(agentRoot, directory)) ? sourceFiles(join(agentRoot, directory)) : []),
    ].map((file) => relative(projectRoot, file));
    expect(entries.length).toBeGreaterThan(20);
    expect(await boundaryProblems(projectRoot, entries, IMAGE_PATHS, productionDependencies)).toEqual([]);
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
      write("agent/computed.ts", [
        "export const a = (name: string) => import(name);",
        "export const b = (name: string) => import(`${name}`);",
        "export const c = (name: string) => import(\"file:\" + name);",
        "export const d = (name: string) => require(name);",
        "export const harmless = \"use import(name) to load\";",
      ].join("\n"));
      write("scripts/notes.md", "text");
      write("agent/notes.md", "text");
      write("agent/assets.ts", "import outside from \"../scripts/notes.md?raw\"; import inside from \"./notes.md\"; export { inside, outside };");
      write("agent/packages.ts", "import \"pg\"; import \"vitest\"; import \"node:fs\"; import \"fs\";");
      const problems = await boundaryProblems(
        root, readdirSync(join(root, "agent")).filter((file) => file.endsWith(".ts")).map((file) => `agent/${file}`),
        ["agent"], new Set(["pg"]),
      );
      expect(problems.filter((problem) => problem.includes("is bundled but not in the image")).sort()).toEqual([
        "scripts/dynamic.ts is bundled but not in the image",
        "scripts/required.cjs is bundled but not in the image",
        "scripts/side.ts is bundled but not in the image",
        "scripts/star.ts is bundled but not in the image",
      ]);
      const computed = problems.filter((problem) => problem.includes("computed specifier"));
      expect(computed).toHaveLength(4);
      expect(computed.some((problem) => problem.includes("use import"))).toBe(false);
      expect(problems).toContain("scripts/notes.md (asset) is not in the image");
      expect(problems.some((problem) => problem.includes("agent/notes.md"))).toBe(false);
      expect(problems.filter((problem) => problem.includes("production dependency"))).toEqual([
        "agent/packages.ts imports vitest, which is not a production dependency",
      ]);

      write("agent/missing.ts", "import \"./nowhere.js\";");
      const missing = await boundaryProblems(root, ["agent/missing.ts"], ["agent"], new Set());
      expect(missing.join("\n")).toMatch(/nowhere\.js/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
