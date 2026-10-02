function mergeRegistrySetupCompletions(...e) {
  let t = e.flatMap((e) => e.facts);
  return e.some((e) => e.deploymentRequired === !0)
    ? { facts: t, deploymentRequired: !0 }
    : { facts: t };
}
export { mergeRegistrySetupCompletions };
