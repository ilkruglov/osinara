import { dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  CACHED_CHANNEL_PREFIX,
  isNodeModulesPath,
  isPathImport,
} from "#internal/authored-package-boundary.js";
const PATH_IMPORT_FILTER = /^(?:\.|\/|[A-Za-z]:[\\/])/;
function createAuthoredRelativeExtensionResolverPlugin(n) {
  let i = createCachedFileProbe();
  return {
    name: `eve-authored-relative-extension-resolver`,
    resolveId: {
      filter: { id: PATH_IMPORT_FILTER },
      handler(a, o) {
        if (
          o === void 0 ||
          o.startsWith(`\0`) ||
          o.startsWith(CACHED_CHANNEL_PREFIX) ||
          !isPathImport(a)
        )
          return;
        let s = resolveExistingImportPath(
          isAbsolute(a) ? a : resolve(dirname(o), a),
          n.extensions,
          i,
        );
        if (s !== void 0)
          return { id: isNodeModulesPath(s) ? toRealModulePath(s) : s };
      },
    },
  };
}
function createCachedFileProbe() {
  let e = new Map();
  return (t) => {
    let n = e.get(t);
    if (n !== void 0) return n;
    let r = !1;
    try {
      r = statSync(t).isFile();
    } catch {}
    return (e.set(t, r), r);
  };
}
function resolveExistingImportPath(e, t, r) {
  if (r(e)) return e;
  for (let n of t) {
    let t = `${e}${n}`;
    if (r(t)) return t;
  }
  for (let i of t) {
    let t = join(e, `index${i}`);
    if (r(t)) return t;
  }
}
function toRealModulePath(e) {
  try {
    return realpathSync(e);
  } catch {
    return e;
  }
}
export { createAuthoredRelativeExtensionResolverPlugin };
