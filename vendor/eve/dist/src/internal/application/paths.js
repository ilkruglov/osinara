import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
  resolvePackageSourceDirectoryPath,
} from "#internal/application/package.js";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
const EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV = `EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY`,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV = `EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY`;
function resolveApplicationRoot(e = process.cwd()) {
  return resolve(e);
}
function getWorkflowBuildCacheKey(t) {
  return createHash(`sha256`).update(t).digest(`hex`).slice(0, 12);
}
function isVercelBuildEnvironment() {
  return !!process.env.VERCEL;
}
function resolveNitroBuildDirectory(e) {
  return join(e, `.eve`, `nitro`);
}
function resolveApplicationHostArtifactsDirectory(e) {
  return join(e, `.eve`, `host`);
}
function resolveWorkflowBuildDirectory(e) {
  let n = join(resolvePackageRoot(), `.eve`, `workflow-cache`);
  return (
    pruneStaleWorkflowCacheSiblings(n),
    join(n, getWorkflowBuildCacheKey(e))
  );
}
function pruneStaleWorkflowCacheSiblings(e) {
  if (!existsSync(e)) return;
  let n = resolveInstalledPackageInfo().version,
    i;
  try {
    i = readdirSync(e);
  } catch {
    return;
  }
  for (let r of i) {
    let i = join(e, r),
      a = join(i, `eve-cache.json`);
    if (existsSync(a))
      try {
        let e = JSON.parse(readFileSync(a, `utf8`));
        typeof e.eveVersion == `string` &&
          e.eveVersion !== n &&
          rmSync(i, { force: !0, recursive: !0 });
      } catch {}
  }
}
function resolveSandboxCacheDirectory(e) {
  return join(e, `.eve`, `sandbox-cache`);
}
function resolveOutputDirectory(e) {
  return isVercelBuildEnvironment()
    ? join(e, `.vercel`, `output`)
    : join(e, `.output`);
}
function getApplicationInfo(e) {
  return {
    appRoot: e,
    outputDir: resolveOutputDirectory(e),
    workflowId: workflowEntryReference.workflowId,
    workflowBuildDir: resolveWorkflowBuildDirectory(e),
    workflowSourceDir: resolvePackageSourceDirectoryPath(`src/execution`),
  };
}
export {
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
  getApplicationInfo,
  isVercelBuildEnvironment,
  resolveApplicationHostArtifactsDirectory,
  resolveApplicationRoot,
  resolveNitroBuildDirectory,
  resolveOutputDirectory,
  resolveSandboxCacheDirectory,
  resolveWorkflowBuildDirectory,
};
