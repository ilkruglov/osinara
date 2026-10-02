import { createTuiPrompter } from "./tui-prompter.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import { WizardCancelledError } from "#setup/step.js";
import { runLoginFlow } from "#setup/flows/login.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { runInstallVercelCliFlow } from "#setup/flows/install-vercel-cli.js";
import { runModelFlow } from "#setup/flows/model.js";
import { runProviderFlow } from "#setup/flows/provider.js";
import {
  RegistryFlowFailedError,
  runRegistryFlow,
} from "#setup/flows/registry.js";
const SETUP_FLOW_CONFIG = {
  "vc:install": { title: `Install the Vercel CLI`, indicator: `pulse` },
  "vc:login": { title: `Log in to Vercel`, indicator: `pulse` },
  model: { title: `Configure the agent model`, indicator: `pulse` },
  add: { title: `Add to your agent`, indicator: `pulse` },
  deploy: { title: `Deploy to Vercel`, indicator: `spinner` },
};
function joinedTitles(e) {
  return e.length === 0
    ? ``
    : e.length === 1
      ? e[0]
      : e.length === 2
        ? `${e[0]} and ${e[1]}`
        : `${e.slice(0, -1).join(`, `)}, and ${e.at(-1)}`;
}
function registryResultMessage(e) {
  let t = [`Added ${joinedTitles(e.items.map((e) => e.title))}`];
  for (let n of e.items) {
    if (n.facts.length === 0 && n.output.length === 0) continue;
    t.push(``, n.title);
    let e = Math.max(0, ...n.facts.map((e) => e.label.length));
    for (let r of n.facts) t.push(`  ${r.label.padEnd(e)}  ${r.value}`);
    for (let e of n.output) t.push(`  ${e}`);
  }
  return t.join(`
`);
}
function muteableRenderer(e, t, n) {
  return {
    readSelect: (n) => (t() ? Promise.resolve(void 0) : e.readSelect(n)),
    readEditableSelect: (n) =>
      t() ? Promise.resolve(void 0) : e.readEditableSelect(n),
    readProviderPicker: (n) =>
      t() ? Promise.resolve(void 0) : e.readProviderPicker(n),
    readModelEditor: (n) =>
      t() ? Promise.resolve(void 0) : e.readModelEditor(n),
    readText: (n) => (t() ? Promise.resolve(void 0) : e.readText(n)),
    readAcknowledge: (n) => (t() ? Promise.resolve() : e.readAcknowledge(n)),
    readChoice: (n) =>
      t()
        ? { choice: Promise.resolve(void 0), close: () => {} }
        : e.readChoice(n),
    setStatus: (n) => {
      t() || e.setStatus(n);
    },
    renderLine: (n, r) => {
      (!t() || r === `warning` || r === `error`) && e.renderLine(n, r);
    },
    replaceContent: (n) => {
      t() || e.replaceContent?.(n);
    },
    renderOutput: (n) => {
      t() || e.renderOutput(n);
    },
    withInheritedStdio: (t) => e.withInheritedStdio(t),
    withExclusiveTerminal: (e) => n?.(e) ?? e(),
  };
}
async function runTuiSetupCommand(t) {
  let { command: r } = t,
    i = !1,
    a = new AbortController(),
    o = muteableRenderer(t.renderer, () => i, t.withExclusiveTerminal),
    s = (t.createPrompter ?? createTuiPrompter)(o),
    c = t.renderer.waitForInterrupt(),
    l = Symbol(`interrupted`),
    u = executeSetupCommand(t, s, o, a.signal);
  try {
    let e = await Promise.race([u, c.promise.then(() => l)]);
    return e === l
      ? ((i = !0),
        a.abort(new WizardCancelledError()),
        {
          ...(await u),
          message: `/${r} interrupted.`,
          tone: `error`,
          preserveFlowDiagnostics: !0,
        })
      : e;
  } finally {
    (c.dispose(), t.renderer.setStatus(void 0));
  }
}
async function executeSetupCommand(e, i, u, d) {
  let { command: f, appRoot: p } = e,
    m = {
      runInstallVercelCliFlow,
      runLoginFlow,
      runModelFlow,
      runRegistryFlow,
      runDeployFlow,
      ...e.flows,
    };
  try {
    switch (f) {
      case `vc:install`:
        return installVercelCliResultMessage(
          await m.runInstallVercelCliFlow({
            appRoot: p,
            prompter: i,
            signal: d,
          }),
        );
      case `vc:login`:
        return loginResultMessage(
          await m.runLoginFlow({ appRoot: p, prompter: i, signal: d }),
        );
      case `model`: {
        let pickProvider = (e) => u.readProviderPicker(e),
          t = {
            appRoot: p,
            prompter: i,
            signal: d,
            chatGptAccountLabel: e.chatGptAccountLabel,
            deps: {
              pickModelSettings: (e) => u.readModelEditor(e),
              runProviderFlow: (e) =>
                runProviderFlow({ ...e, picker: pickProvider }),
            },
          };
        (e.initialModelStep !== void 0 && (t.initialStep = e.initialModelStep),
          (t.withExclusiveTerminal = (t) =>
            u.withInheritedStdio(() => e.withExclusiveTerminal?.(t) ?? t())));
        let n = await m.runModelFlow(t);
        if (n.kind === `cancelled`)
          return {
            message:
              n.discardedDraft === !0
                ? `/model dismissed. Drafted changes were discarded; Done commits them.`
                : `/model dismissed.`,
            preserveFlowDiagnostics: !1,
          };
        let r = [];
        (n.modelMessage !== void 0 && r.push(n.modelMessage),
          n.providerSelection !== void 0 &&
            r.push(providerSelectionMessage(n.providerSelection)));
        let a = {
          message: r.join(`
`),
          preserveFlowDiagnostics: !1,
        };
        return (
          n.accessChanged && (a.effect = { kind: `model-access-changed` }),
          a
        );
      }
      case `add`: {
        let e = await m.runRegistryFlow({ appRoot: p, prompter: i, signal: d });
        if (e.kind === `cancelled`)
          return { message: `/add dismissed.`, preserveFlowDiagnostics: !0 };
        let t = {
          message:
            e.addedItems.length > 0
              ? registryResultMessage(e)
              : `No registry items added.`,
          preserveFlowDiagnostics: !0,
        };
        return (
          e.addedItems.length > 0 && (t.tone = `success`),
          e.deployed === `production` && (t.effect = { kind: `deployed` }),
          t
        );
      }
      case `deploy`: {
        let e = await m.runDeployFlow({
          appRoot: p,
          prompter: i,
          interactive: !0,
          signal: d,
        });
        return e.kind === `cancelled`
          ? { message: `/deploy dismissed.`, preserveFlowDiagnostics: !0 }
          : e.kind === `needs-link`
            ? {
                message: `Not linked to a Vercel project — run /model to connect one first.`,
                preserveFlowDiagnostics: !0,
              }
            : e.kind === `local-model`
              ? {
                  message: `ChatGPT subscription models are local-only. Switch to an AI Gateway or server-authenticated model before deploying.`,
                  preserveFlowDiagnostics: !0,
                }
              : {
                  message:
                    e.productionUrl === void 0
                      ? `Deployed.`
                      : `Deployed: ${e.productionUrl}`,
                  preserveFlowDiagnostics: !0,
                  effect: { kind: `deployed` },
                };
      }
    }
  } catch (e) {
    if (e instanceof RegistryFlowFailedError) {
      let t = e.completed;
      return {
        message: `${registryResultMessage(t)}\n\n${e.message}`,
        tone: `error`,
        preserveFlowDiagnostics: !0,
      };
    }
    if (e instanceof WizardCancelledError)
      return {
        message: `/${f} dismissed.`,
        preserveFlowDiagnostics: f !== `model`,
      };
    let t = await vercelCliUpgradeOutcome(e, f, m, {
      appRoot: p,
      prompter: i,
      signal: d,
    });
    if (t !== void 0) return t;
    let r = vercelActionOutcome(e, f);
    return r === void 0
      ? {
          message: `/${f} failed: ${e instanceof Error ? e.message : String(e)}`,
          tone: `error`,
          preserveFlowDiagnostics: !0,
        }
      : r;
  }
}
async function vercelCliUpgradeOutcome(e, t, n, r) {
  if (
    !(e instanceof HumanActionRequiredError) ||
    e.action.kind !== `vercel-cli-upgrade`
  )
    return;
  let a;
  try {
    a = await r.prompter.select({
      message: `Your Vercel CLI needs an update to list your teams. Upgrade now?`,
      options: [
        {
          value: `upgrade`,
          label: `Upgrade Vercel CLI`,
          description: `Run the Vercel CLI's native upgrader`,
        },
        { value: `later`, label: `Not now` },
      ],
      initialValue: `upgrade`,
    });
  } catch {
    a = `later`;
  }
  if (a === `later`)
    return {
      message: `The Vercel CLI needs an update — run \`vercel upgrade\`, then retry /${t}.`,
      preserveFlowDiagnostics: !0,
    };
  let o;
  try {
    o = await n.runInstallVercelCliFlow({
      appRoot: r.appRoot,
      prompter: r.prompter,
      signal: r.signal,
      upgrade: !0,
    });
  } catch (e) {
    return {
      message: vercelCliUpgradeFailureMessage(t, errorMessage(e)),
      preserveFlowDiagnostics: !0,
    };
  }
  switch (o.kind) {
    case `installed`:
      return {
        message: `Upgraded the Vercel CLI. Retry /${t}.`,
        preserveFlowDiagnostics: !1,
      };
    case `failed`:
      return {
        message: vercelCliUpgradeFailureMessage(t, o.reason),
        preserveFlowDiagnostics: !0,
      };
    case `cancelled`:
      return {
        message: `Vercel CLI upgrade cancelled — run \`vercel upgrade\`, then retry /${t}.`,
        preserveFlowDiagnostics: !0,
      };
    case `already`:
      return {
        message: `The Vercel CLI is already up to date. Retry /${t}.`,
        preserveFlowDiagnostics: !1,
      };
  }
}
function errorMessage(e) {
  let t = (e instanceof Error ? e.message : String(e))
    .replace(/\s+/gu, ` `)
    .trim();
  return t.length <= 240 ? t : `${t.slice(0, 239)}…`;
}
function vercelCliUpgradeFailureMessage(e, t) {
  return `Couldn't upgrade the Vercel CLI${t === void 0 || t === `` ? `` : ` (${t})`} — run \`vercel upgrade\`, then retry /${e}.`;
}
function vercelActionOutcome(e, t) {
  if (!(e instanceof HumanActionRequiredError)) return;
  let n = vercelActionMessage(e.action.kind, t);
  return n === void 0 ? void 0 : { message: n, preserveFlowDiagnostics: !0 };
}
function vercelActionMessage(e, t) {
  switch (e) {
    case `vercel-login`:
      return `You're not logged in to Vercel — run /vc:login, then retry /${t}.`;
    case `vercel-forbidden`:
      return `Vercel denied access to that team — run /vc:login to re-authenticate (for example to complete SSO), or pick a team you can access, then retry /${t}.`;
    case `vercel-cli-missing`:
      return `The Vercel CLI isn't installed — run /vc:install to install it, then retry /${t}.`;
    case `vercel-cli-upgrade`:
      return `The Vercel CLI needs an update — run \`vercel upgrade\`, then retry /${t}.`;
    default:
      return;
  }
}
function installVercelCliResultMessage(e) {
  switch (e.kind) {
    case `cancelled`:
      return { message: `/vc:install dismissed.`, preserveFlowDiagnostics: !1 };
    case `already`:
      return {
        message: `The Vercel CLI is already installed.`,
        preserveFlowDiagnostics: !1,
      };
    case `failed`:
      return {
        message:
          "Couldn't install the Vercel CLI — install it manually with `npm i -g vercel@latest`.",
        preserveFlowDiagnostics: !0,
      };
    case `installed`:
      return {
        message: `Installed the Vercel CLI. Run /vc:login next.`,
        preserveFlowDiagnostics: !1,
        effect: { kind: `refresh-identity` },
      };
  }
}
function loginResultMessage(e) {
  switch (e.kind) {
    case `cancelled`:
      return { message: `/vc:login dismissed.`, preserveFlowDiagnostics: !1 };
    case `already`:
      return {
        message: `You're already logged in to Vercel.`,
        preserveFlowDiagnostics: !1,
      };
    case `cli-missing`:
      return {
        message: `The Vercel CLI isn't installed — run /vc:install to install it, then retry /vc:login.`,
        preserveFlowDiagnostics: !0,
      };
    case `failed`:
      return {
        message: `Vercel login didn't complete — run /vc:login to try again.`,
        preserveFlowDiagnostics: !0,
      };
    case `logged-in`:
      return {
        message: `Logged in to Vercel.`,
        preserveFlowDiagnostics: !1,
        effect: { kind: `refresh-identity` },
      };
    case `unavailable`:
      return {
        message: `Couldn't reach Vercel — check your connection, then retry /vc:login.`,
        preserveFlowDiagnostics: !0,
      };
  }
}
function providerSelectionMessage(e) {
  return e === `chatgpt`
    ? `ChatGPT subscription selected.`
    : e === `ai-gateway-project`
      ? `AI Gateway via Project selected.`
      : `AI Gateway via API key selected.`;
}
export { SETUP_FLOW_CONFIG, runTuiSetupCommand };
