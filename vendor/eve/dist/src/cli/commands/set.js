import {
  changeAgentModelSettings,
  formatApplyModelSettingsOutcome,
} from "#setup/flows/model-source-change.js";
const defaultDependencies = { changeAgentModelSettings };
function fail(e, t) {
  (e.error(t), (process.exitCode = 1));
}
async function runSetCommand(e, r, i, a = defaultDependencies) {
  if (i.model === void 0 && i.reasoning === void 0) {
    fail(e, `Pass --model, --reasoning, or both.`);
    return;
  }
  let o = {
    model:
      i.model === void 0 ? { kind: `keep` } : { kind: `set`, value: i.model },
    reasoning:
      i.reasoning === void 0
        ? { kind: `keep` }
        : i.reasoning === `provider-default`
          ? { kind: `remove` }
          : { kind: `set`, value: i.reasoning },
    gatewayServiceTier: { kind: `keep` },
  };
  try {
    let n = await a.changeAgentModelSettings({ appRoot: r, patch: o });
    if (n.kind === `rejected`) {
      fail(e, n.message);
      return;
    }
    e.log(formatApplyModelSettingsOutcome(n));
  } catch (t) {
    fail(
      e,
      `Couldn't update model settings: ${t instanceof Error ? t.message : String(t)}`,
    );
  }
}
export { runSetCommand };
