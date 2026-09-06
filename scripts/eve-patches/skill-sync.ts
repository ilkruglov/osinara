import { resolve } from "node:path";

export async function patchSkillSync(replace: (path: string, before: string, after: string) => Promise<void>) {
  // The application's Docker backend verifies all bytes in one round trip. Native backends such
  // as the pinned just-bash eval backend keep Eve's original, supported per-file implementation.
  await replace(resolve("node_modules/eve/dist/src/context/dynamic-skill-lifecycle.js"),
    "for(let e of t)await removeSkillPackageFromSandbox({name:e,sandbox:_});for(let{skills:e}of p)for(let t of e)await writeSkillPackageToSandbox({sandbox:_,skill:t})",
    "if(typeof _.syncSkillPackages===`function`)await _.syncSkillPackages(p.flatMap(e=>e.skills),[...t]);else{for(let e of t)await removeSkillPackageFromSandbox({name:e,sandbox:_});for(let{skills:e}of p)for(let t of e)await writeSkillPackageToSandbox({sandbox:_,skill:t})}");
}
