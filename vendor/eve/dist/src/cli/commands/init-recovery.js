import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
async function cleanupFreshInitTarget(t, n, r = []) {
  try {
    if (n === `remove`) await rm(t, { recursive: !0, force: !0 });
    else {
      let n = new Set(r);
      for (let r of await readdir(t))
        n.has(r) || (await rm(join(t, r), { recursive: !0, force: !0 }));
    }
    return !0;
  } catch {
    return !1;
  }
}
function workspaceFailureNote(e) {
  return e
    ? `

Shared workspace files may have changed. Review your workspace changes before committing.`
    : ``;
}
export { cleanupFreshInitTarget, workspaceFailureNote };
