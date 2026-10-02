import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  resolvePackageSourceDirectoryPath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import {
  WORKFLOW_BUILDER_DEFERRED_PACKAGES,
  WORKFLOW_STEP_EXTERNAL_PACKAGES,
} from "#internal/workflow-bundle/vercel-workflow-output.js";
import { deriveEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import { detectWorkflowPatterns } from "#internal/workflow-bundle/workflow-builders.js";
import { runQueuedWorkflowBuild } from "#internal/workflow-bundle/build-queue.js";
import {
  WORKFLOW_VIRTUAL_ENTRY_ID,
  bundleFinalWorkflowOutput,
  collectWorkflowInputFiles,
  convertClassesManifest,
  convertStepsManifest,
  convertWorkflowsManifest,
  createEvePackageImportsPlugin,
  createWorkflowImport,
  createWorkflowNodeBuiltinGuardPlugin,
  createWorkflowPseudoPackagePlugin,
  createWorkflowTransformPlugin,
  createWorkflowVirtualEntryPlugin,
} from "#internal/workflow-bundle/builder-support.js";
import { writeNitroStepEntrypoint } from "#internal/workflow-bundle/nitro-step-entry.js";
var WorkflowBundleBuilder = class {
  #e;
  #t;
  #n;
  config;
  #r = new WeakMap();
  constructor(e) {
    let t = [resolvePackageSourceDirectoryPath(`src/execution`)];
    (e.includeTestFixtures === !0 &&
      t.push(resolvePackageSourceDirectoryPath(`src/internal/testing`)),
      (this.config = {
        buildTarget: `standalone`,
        dirs: t,
        externalPackages: [
          ...WORKFLOW_STEP_EXTERNAL_PACKAGES,
          ...WORKFLOW_BUILDER_DEFERRED_PACKAGES,
        ],
        projectRoot: e.appRoot,
        watch: e.watch,
        workingDir: e.rootDir,
      }),
      (this.#e = e.compiledArtifactsBootstrapPath),
      (this.#t = e.outDir),
      (this.#n = deriveEveWorkflowQueueNamespace(e.agentName)));
  }
  async build(e = {}) {
    await runQueuedWorkflowBuild(this.#t, async () => this.#i(e));
  }
  async #i(t) {
    await prepareEveVersionedCacheDirectory(this.#t);
    let n = await this.#a();
    if (n.length === 0)
      throw Error(
        `Expected the execution workflow source file under "${resolvePackageSourceDirectoryPath(`src/execution`)}".`,
      );
    let r = await this.findTsConfigPath();
    await mkdir(this.#t, { recursive: !0 });
    let a = await this.discoverEntries(n, this.#t, r),
      c = join(this.#t, `steps.mjs`),
      d = join(this.#t, `workflows.mjs`),
      f = t.nitroStepOutfile,
      p = t.nitroWorkflowOutfile,
      m = await writeNitroStepEntrypoint({
        builtinsPath: resolveWorkflowModulePath(`workflow/internal/builtins`),
        discoveredEntries: a,
        outfile: c,
        preferAbsoluteFileImports: !0,
        projectRoot: this.config.projectRoot ?? this.config.workingDir,
        sideEffectFiles: [this.#e],
        workingDir: this.config.workingDir,
      });
    f !== void 0 &&
      f !== c &&
      (await writeNitroStepEntrypoint({
        builtinsPath: resolveWorkflowModulePath(`workflow/internal/builtins`),
        discoveredEntries: a,
        outfile: f,
        preferAbsoluteFileImports: !0,
        projectRoot: this.config.projectRoot ?? this.config.workingDir,
        sideEffectFiles: [this.#e],
        workingDir: this.config.workingDir,
      }));
    let { manifest: h } = await this.createWorkflowsBundle({
      additionalOutputs:
        p === void 0 || p === d
          ? []
          : [{ outfile: p, stepRegistrationsPath: f ?? c }],
      discoveredEntries: a,
      outfile: d,
      inputFiles: n,
      stepRegistrationsPath: c,
      tsconfigPath: r,
    });
    (await this.createManifest({
      workflowBundlePath: join(this.#t, `workflows.mjs`),
      manifestDir: this.#t,
      manifest: {
        steps: { ...m.steps, ...h.steps },
        workflows: { ...m.workflows, ...h.workflows },
        classes: { ...m.classes, ...h.classes },
      },
    }),
      await writeEveVersionedCacheMetadata(this.#t));
  }
  get transformProjectRoot() {
    return this.config.projectRoot ?? this.config.workingDir;
  }
  async findTsConfigPath() {
    let e = this.config.workingDir;
    for (;;) {
      for (let n of [`tsconfig.json`, `jsconfig.json`]) {
        let r = join(e, n);
        try {
          return (await readFile(r), r);
        } catch (e) {
          if (!(e instanceof Error && `code` in e && e.code === `ENOENT`))
            throw e;
        }
      }
      let n = dirname(e);
      if (n === e) return;
      e = n;
    }
  }
  async getInputFiles() {
    let e = this.config.dirs.map((e) => resolve(this.config.workingDir, e));
    return (
      await Promise.all(e.map((e) => collectWorkflowInputFiles(e)))
    ).flat();
  }
  async discoverEntries(e, n, r) {
    let i = this.#r.get(e);
    if (i !== void 0) return i;
    let a = {
      discoveredSerdeFiles: [],
      discoveredSteps: [],
      discoveredWorkflows: [],
    };
    for (let n of e) {
      let e = detectWorkflowPatterns(await readFile(n, `utf8`));
      (e.hasUseStep && a.discoveredSteps.push(n),
        e.hasUseWorkflow && a.discoveredWorkflows.push(n),
        e.hasSerde && a.discoveredSerdeFiles.push(n));
    }
    return (this.#r.set(e, a), a);
  }
  async createWorkflowsBundle({
    additionalOutputs: e = [],
    discoveredEntries: t,
    inputFiles: n,
    outfile: i,
    stepRegistrationsPath: a,
    tsconfigPath: o,
  }) {
    let s = t ?? (await this.discoverEntries(n, dirname(i), o)),
      l = [...s.discoveredWorkflows].sort(),
      u = new Set(l),
      d = [...s.discoveredSerdeFiles].sort().filter((e) => !u.has(e)),
      f = {},
      p = [
        ...l.map((e) => createWorkflowImport(e, this.config.workingDir)),
        ...d.map((e) => createWorkflowImport(e, this.config.workingDir)),
      ].join(`
`),
      m = await buildSingleRolldownChunk(
        `intermediate workflow bundle for "${i}"`,
        {
          cwd: this.config.workingDir,
          input: WORKFLOW_VIRTUAL_ENTRY_ID,
          platform: `neutral`,
          plugins: [
            createWorkflowVirtualEntryPlugin(p),
            createWorkflowPseudoPackagePlugin(),
            createEvePackageImportsPlugin(this.config.workingDir, {
              workflowCondition: !0,
            }),
            createWorkflowTransformPlugin({
              manifest: f,
              projectRoot: this.transformProjectRoot,
              sideEffectFiles: [...l, ...d],
              workingDir: this.config.workingDir,
            }),
            createWorkflowNodeBuiltinGuardPlugin(),
          ],
          resolve: {
            conditionNames: [`eve-source`, `workflow`],
            extensions: [
              `.ts`,
              `.tsx`,
              `.mts`,
              `.cts`,
              `.js`,
              `.jsx`,
              `.mjs`,
              `.cjs`,
            ],
            mainFields: [`module`, `main`],
          },
          tsconfig: o ?? !1,
          output: {
            banner: `globalThis.__private_workflows = new Map();`,
            comments: !1,
            format: `cjs`,
            sourcemap: `inline`,
          },
        },
      );
    return (
      await Promise.all(
        [{ outfile: i, stepRegistrationsPath: a }, ...e].map((e) =>
          bundleFinalWorkflowOutput({
            code: m.code,
            outfile: e.outfile,
            queueNamespace: this.#n,
            stepRegistrationsPath: e.stepRegistrationsPath,
          }),
        ),
      ),
      { manifest: f }
    );
  }
  async createManifest({ manifest: t, manifestDir: r }) {
    let a = {
        version: `1.0.0`,
        steps: convertStepsManifest(t.steps),
        workflows: convertWorkflowsManifest(t.workflows),
        classes: convertClassesManifest(t.classes),
      },
      o = JSON.stringify(a, null, 2);
    return (
      await mkdir(r, { recursive: !0 }),
      await writeFile(join(r, `manifest.json`), o),
      o
    );
  }
  async #a() {
    return await this.getInputFiles();
  }
};
export { WorkflowBundleBuilder };
