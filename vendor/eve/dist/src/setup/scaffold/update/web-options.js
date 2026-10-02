import { DEFAULT_EVE_PACKAGE_CONTRACT } from "../create/project.js";
function resolveWebPackageVersions(e, t) {
  return {
    evePackage: e?.evePackage ?? DEFAULT_EVE_PACKAGE_CONTRACT,
    aiPackageVersion: e?.aiPackageVersion ?? `^7.0.58`,
    betterAuthPackageVersion: e?.betterAuthPackageVersion ?? `1.6.26`,
    nextPackageVersion:
      e?.nextPackageVersion ??
      (t === `sign-in-with-vercel` ? `16.3.0` : `16.3.0-preview.6`),
    reactPackageVersion: e?.reactPackageVersion ?? `19.2.6`,
    reactDomPackageVersion: e?.reactDomPackageVersion ?? `19.2.6`,
    streamdownPackageVersion: e?.streamdownPackageVersion ?? `2.5.0`,
    zodPackageVersion: e?.zodPackageVersion ?? `4.4.3`,
    typesReactPackageVersion: e?.typesReactPackageVersion ?? `19.2.15`,
    typesReactDomPackageVersion: e?.typesReactDomPackageVersion ?? `19.2.3`,
  };
}
export { resolveWebPackageVersions };
