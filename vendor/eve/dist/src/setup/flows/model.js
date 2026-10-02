import { __toESM } from "../../_virtual/_rolldown/runtime.js";
import { require_picocolors } from "../../node_modules/.pnpm/picocolors@1.1.1/node_modules/picocolors/picocolors.js";
import { AI_GATEWAY_API_KEY_ENV_VAR } from "../ai-gateway-api-key.js";
import { withSpinner } from "../with-spinner.js";
import { gatewayModelCapabilities } from "../boxes/model-capabilities.js";
import {
  fetchGatewayCatalog,
  modelOptionsFromCatalog,
} from "../boxes/select-model.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";
import { WizardCancelledError } from "../step.js";
import {
  changeAgentModelSettings,
  formatApplyModelSettingsOutcome,
} from "./model-source-change.js";
import { runProviderFlow } from "./provider.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import { inspectApplication } from "#services/inspect-application.js";
import {
  readProviderSelection,
  resolveAvailableProviders,
  writeProviderSelection,
} from "#setup/provider-settings.js";
import { formatModelSummary } from "#shared/model-summary.js";
import { readGatewayServiceTier } from "#shared/gateway-service-tier.js";
import {
  DEFAULT_CHATGPT_MODEL_SELECTION,
  isChatGptModelRouting,
  parseChatGptModelSelection,
} from "#shared/chatgpt-model.js";
var import_picocolors = __toESM(require_picocolors(), 1);
const MODEL_MENU_MESSAGE = ``;
function providerSelectionHint(e, t) {
  return e === `chatgpt`
    ? t === void 0
      ? `ChatGPT subscription`
      : `ChatGPT subscription (${t})`
    : e === `ai-gateway-project`
      ? `AI Gateway via Project`
      : `AI Gateway via ${AI_GATEWAY_API_KEY_ENV_VAR}`;
}
function modelListRows(e) {
  return modelOptionsFromCatalog(e).map((e) => {
    let t = { value: e.value, label: e.value };
    return (e.featured === !0 && (t.featured = !0), t);
  });
}
function formatModelDraftHint(e, t, n) {
  let r = { model: e };
  return (
    t !== null && (r.reasoning = t),
    n.kind === `priority` && (r.fastGlyph = `↯`),
    formatModelSummary(r)
  );
}
function modelMenuRows(e, t, n, r, i, a, o, s, c) {
  let l;
  s || c
    ? ((l = {
        value: `model`,
        label: `Change model`,
        description: s
          ? `The model, its reasoning effort, and the Gateway service tier`
          : `Reasoning and service tier; the model itself is an SDK model call in agent.ts`,
      }),
      e !== null && (l.hint = formatModelDraftHint(e, t, n)))
    : (l = {
        value: `model`,
        label: `Change model`,
        disabled: !0,
        description: `Set via an SDK model call in agent.ts; edit the source to change it`,
      });
  let u;
  return (
    (u =
      o?.kind === `external` && !isChatGptModelRouting(o)
        ? {
            disabled: !0,
            value: `provider`,
            label: `Change provider`,
            description: `Disabled in external endpoint mode`,
          }
        : i
          ? {
              value: `provider`,
              label: `Change provider`,
              hint: providerSelectionHint(r, a),
              description: `How your agent reaches the model provider`,
            }
          : {
              value: `provider`,
              label: import_picocolors.default.bold(`Configure model access`),
              hint: import_picocolors.default.yellow(`Not configured`),
              description: `How your agent reaches the model provider`,
              accent: `warning`,
            }),
    [l, u, { value: `done`, label: `Done` }]
  );
}
async function runModelFlow(e) {
  let { appRoot: t, prompter: n, signal: o } = e,
    d = {
      readCurrentModel: readCurrentAgentModel,
      applySettings: changeAgentModelSettings,
      resolveAvailableProviders,
      readProviderSelection,
      runProviderFlow,
      ensureChatGptAuth,
      writeProviderSelection,
      ...e.deps,
    },
    f = d.selectModel?.fetchModels ?? fetchGatewayCatalog,
    [p, m, h, g] = await withSpinner(n, `Checking the project…`, () =>
      Promise.all([
        d.readCurrentModel(t),
        d.resolveAvailableProviders(
          t,
          o === void 0 ? { env: process.env } : { signal: o, env: process.env },
        ),
        d.readProviderSelection(t),
        f(o).catch(() => void 0),
      ]),
    );
  o?.throwIfAborted();
  let {
      id: _,
      routing: v,
      serviceTier: y,
      editable: b,
      settingsEditable: x,
    } = p,
    S = p.reasoning === `provider-default` ? null : p.reasoning,
    C =
      h ??
      (m.includes(`ai-gateway-key`) ? `ai-gateway-key` : `ai-gateway-project`),
    w = m.includes(C),
    T,
    E = {
      model: { kind: `keep` },
      reasoning: { kind: `keep` },
      gatewayServiceTier: { kind: `keep` },
    },
    D,
    O,
    k = !1,
    A = !1,
    j = v?.kind === `external` && !isChatGptModelRouting(v),
    M = j
      ? {
          tone: `warning`,
          text: "`agent.ts` specifies the model provider directly. Model, provider, and service-tier changes stay source-owned; reasoning remains configurable here.",
        }
      : void 0,
    N =
      !w && v?.kind !== `external` ? `provider` : b || x ? `model` : `provider`,
    P = v?.kind !== `external` && (e.initialStep === `provider` || !w);
  for (;;) {
    let r;
    if (P) ((P = !1), (r = `provider`));
    else
      try {
        r = await n.select({
          message: ``,
          options: modelMenuRows(
            _,
            S,
            isChatGptModelRouting(v) ? { kind: `standard` } : y,
            C,
            w,
            e.chatGptAccountLabel,
            v,
            b,
            x,
          ),
          hintLayout: `stacked`,
          initialValue: N,
          notices: M === void 0 ? [] : [M],
        });
      } catch (e) {
        if (!(e instanceof WizardCancelledError)) throw e;
        if (hasModelSettingsChanges(E))
          return { kind: `cancelled`, discardedDraft: !0 };
        break;
      }
    if (r === `done`) {
      A = !0;
      break;
    }
    if (r === `model`) {
      let e = d.pickModelSettings;
      if (e === void 0)
        throw Error(
          `runModelFlow requires a pickModelSettings dep to open the model screen.`,
        );
      let t = await e({
        model: b
          ? { kind: `pick`, options: modelListRows(g), current: _ }
          : {
              kind: `fixed`,
              current: _,
              reason: `Set via an SDK model call in agent.ts; edit the source to change it`,
            },
        reasoning: S,
        serviceTier: isChatGptModelRouting(v) ? { kind: `standard` } : y,
        settingsEditable: x,
        externalRouting: j,
        capabilitiesFor: (e) => gatewayModelCapabilities(g, e),
      });
      if ((o?.throwIfAborted(), t === void 0)) {
        N = `model`;
        continue;
      }
      (t.model !== void 0 &&
        ((_ = t.model),
        (v = routingForModelSelection(t.model)),
        (E.model = { kind: `set`, value: t.model })),
        t.reasoning !== void 0 &&
          ((S = t.reasoning === "default" ? null : t.reasoning),
          (E.reasoning =
            S === null ? { kind: `remove` } : { kind: `set`, value: S })),
        t.serviceTier !== void 0 &&
          !isChatGptModelRouting(v) &&
          ((y =
            t.serviceTier === `priority`
              ? { kind: `priority` }
              : { kind: `standard` }),
          (E.gatewayServiceTier =
            t.serviceTier === `priority`
              ? { kind: `set`, value: `priority` }
              : { kind: `remove` })),
        (N = `done`));
      continue;
    }
    let a = await d.runProviderFlow({
      appRoot: t,
      prompter: n,
      signal: o,
      availableProviders: m,
      selectedProvider: C,
    });
    if (a.kind === `cancelled`) {
      if (o?.aborted) return { kind: `cancelled` };
      N = `provider`;
      continue;
    }
    if (a.kind === `external-provider`) {
      if (o?.aborted) return { kind: `cancelled` };
      N = `done`;
      continue;
    }
    ((T = a.kind),
      T === `chatgpt`
        ? ((k = !0),
          isChatGptModelRouting(v) ||
            ((E.model = {
              kind: `set`,
              value: DEFAULT_CHATGPT_MODEL_SELECTION,
            }),
            (E.gatewayServiceTier = { kind: `remove` })))
        : isChatGptModelRouting(v) &&
          (E.model = { kind: `set`, value: DEFAULT_AGENT_MODEL_ID }),
      (A = !0));
    break;
  }
  let F =
    E.model.kind === `set` &&
    parseChatGptModelSelection(E.model.value) !== void 0;
  if (
    (A && F && ((E.gatewayServiceTier = { kind: `remove` }), (k = !0)),
    A && k && (await authenticateChatGpt(d, e.withExclusiveTerminal)),
    A &&
      hasModelSettingsChanges(E) &&
      (D = await d.applySettings({ appRoot: t, patch: E })),
    A &&
      T !== void 0 &&
      D?.kind !== `rejected` &&
      (await d.writeProviderSelection(t, T), (O = T)),
    D !== void 0 && O === void 0 && o?.throwIfAborted(),
    D === void 0 && O === void 0 && !k)
  )
    return { kind: `cancelled` };
  let I = {
    kind: `done`,
    accessChanged: D?.kind === `changed` || O !== void 0 || k,
  };
  return (
    D === void 0
      ? k && (I.modelMessage = `ChatGPT login ready.`)
      : (I.modelMessage = formatApplyModelSettingsOutcome(D)),
    O !== void 0 && (I.providerSelection = O),
    I
  );
}
function routingForModelSelection(e) {
  return parseChatGptModelSelection(e) === void 0
    ? { kind: `gateway`, target: e.split(`/`)[0] ?? `` }
    : { kind: `external`, provider: `codex` };
}
async function authenticateChatGpt(e, t) {
  let authenticate = () => e.ensureChatGptAuth();
  await (t === void 0 ? authenticate() : t(authenticate));
}
function hasModelSettingsChanges(e) {
  return (
    e.model.kind !== `keep` ||
    e.reasoning.kind !== `keep` ||
    e.gatewayServiceTier.kind !== `keep`
  );
}
async function readCurrentAgentModel(e) {
  try {
    let { compiledState: t } = await inspectApplication(e),
      n = t?.manifest.config,
      r = n?.model,
      i = isChatGptModelRouting(r?.routing);
    return {
      id: i && r !== void 0 ? `chatgpt/${r.id}` : (r?.id ?? null),
      routing: r?.routing ?? null,
      reasoning: n?.reasoning ?? null,
      serviceTier: readGatewayServiceTier(r?.providerOptions),
      editable: r !== void 0 && (r.source === void 0 || i),
      settingsEditable: n?.source !== void 0,
    };
  } catch {
    return {
      id: null,
      routing: null,
      reasoning: null,
      serviceTier: { kind: `standard` },
      editable: !1,
      settingsEditable: !1,
    };
  }
}
async function modelChangeRefusalForUneditableModel(e) {
  let { editable: t, routing: n } = await readCurrentAgentModel(e);
  return t
    ? null
    : `Model is set via ${n?.kind === `external` ? `the external provider \`${n.provider}\`` : `an SDK model call`} in agent.ts, not a string literal; /model can't rewrite it. Edit \`model\` in agent.ts.`;
}
export {
  MODEL_MENU_MESSAGE,
  modelChangeRefusalForUneditableModel,
  runModelFlow,
};
