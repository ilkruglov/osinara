import { __toESM } from "../../_virtual/_rolldown/runtime.js";
import { require_picocolors } from "../../node_modules/.pnpm/picocolors@1.1.1/node_modules/picocolors/picocolors.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
var import_picocolors = __toESM(require_picocolors(), 1);
const SETUP_SECTIONS = [
    `intro-setup.md`,
    `collect-intent.md`,
    `vercel-connect.md`,
    `scaffold.md`,
    `build-and-verify.md`,
  ],
  HANDOFF_SECTIONS = [
    `intro-handoff.md`,
    `collect-intent.md`,
    `vercel-connect.md`,
    `build-and-verify.md`,
  ];
function compose(e, t) {
  let n = e
      .map((e) =>
        readFileSync(
          new URL(`./agent-prompt/${e}`, import.meta.url),
          `utf8`,
        ).trim(),
      )
      .join(
        `

`,
      )
      .replaceAll(`{{devCommand}}`, () => t.devCommand),
    { workingDirectory: i } = t;
  return i === void 0 ? n : n.replaceAll(`{{workingDirectory}}`, () => i);
}
function initAgentInstructions() {
  return compose(SETUP_SECTIONS, { devCommand: `npx eve dev` });
}
function initAgentReadySummary(e, t) {
  let r = e ?? DEFAULT_AGENT_MODEL_ID,
    a = e === void 0 ? import_picocolors.default.dim(` (eve default)`) : ``;
  return [
    `${import_picocolors.default.green(`✓`)} Model ${import_picocolors.default.bold(r)}${a}`,
    `${import_picocolors.default.green(`✓`)} Instructions ${import_picocolors.default.bold(join(t, `agent/instructions.md`))}`,
  ].join(`
`);
}
function initAgentDevHandoff(e) {
  return compose(HANDOFF_SECTIONS, {
    devCommand: e.devCommand,
    workingDirectory: e.projectPath,
  });
}
function initAgentReplPrompt(e) {
  return compose(HANDOFF_SECTIONS, {
    devCommand: e.devCommand,
    workingDirectory: `.`,
  });
}
function initExtensionInstructions() {
  return [
    `You are scaffolding an eve extension package (a reusable package of tools,`,
    `connections, skills, and hooks that a consuming agent mounts under`,
    `agent/extensions/).`,
    ``,
    `Ask the user for a package directory name, then run:`,
    ``,
    `    npx eve@latest extension init <name>`,
    ``,
    `That creates the package, installs dependencies, and initializes Git. It`,
    `prints what was set up and how to author, build, and mount the extension —`,
    `it does not start eve dev (extensions are not standalone agents).`,
    ``,
    "Build with `eve extension build` (or the package `build` script).",
  ].join(`
`);
}
function initExtensionHandoff(e) {
  return [
    ``,
    `What we set up:`,
    `  - package.json with eve.extension source/dist roots, peer+dev eve, and zod`,
    `  - extension/extension.ts (config schema via defineExtension)`,
    `  - build/prepare scripts → eve extension build`,
    ``,
    `Next:`,
    `  - Add tools, skills, hooks, or connections under extension/`,
    `    (see AGENTS.md and node_modules/eve/docs/extensions.md)`,
    `  - ${`${e.packageManager} run build`}   # builds dist/extension and package exports`,
    `  - Mount from a consumer agent:`,
    `      // agent/extensions/${e.packageName}.ts`,
    `      import ext from "${e.packageName}";`,
    `      export default ext({ apiKey: process.env.API_KEY });`,
    ``,
    `Working directory: ${e.projectPath}`,
  ].join(`
`);
}
export {
  HANDOFF_SECTIONS,
  SETUP_SECTIONS,
  initAgentDevHandoff,
  initAgentInstructions,
  initAgentReadySummary,
  initAgentReplPrompt,
  initExtensionHandoff,
  initExtensionInstructions,
};
