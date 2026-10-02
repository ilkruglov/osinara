import { appendEnv } from "../append-env.js";
import {
  AI_GATEWAY_API_KEY_ENV_FILE,
  AI_GATEWAY_API_KEY_ENV_VAR,
  writeAiGatewayApiKey,
} from "../ai-gateway-api-key.js";
import { withSpinner } from "../with-spinner.js";
import {
  getVercelAuthStatus,
  vercelAuthBlockerReason,
} from "../vercel-project.js";
import { WizardCancelledError } from "../step.js";
import { runLinkFlow } from "./link.js";
import { validateGatewayApiKey } from "../validate-gateway-key.js";
const PROVIDER_QUESTION = `Which model provider do you want to use?`,
  EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE = `Using another model provider`,
  EXTERNAL_PROVIDER_INSTRUCTIONS = [
    `Set your provider's API key in ${AI_GATEWAY_API_KEY_ENV_FILE} — e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY.`,
    'In agent/agent.ts, set `model` to a provider-authored model — e.g. `anthropic("claude-opus-4.8")` from `@ai-sdk/anthropic`.',
    `See https://eve.dev/docs/agent-config for details.`,
    "A running `eve dev` reloads env files automatically — no restart needed.",
  ];
function projectConnectionOption(e) {
  let t = {
      value: `ai-gateway-project`,
      label: `AI Gateway via Project`,
      hint: `Authenticates with AI Gateway automatically
in a new or existing project. No keys to manage.`,
    },
    n = e === void 0 ? void 0 : vercelAuthBlockerReason(e);
  return n === void 0
    ? t
    : { ...t, disabled: !0, disabledReason: n, disabledReasonTone: `warning` };
}
function providerOptions(e, t) {
  let r = projectConnectionOption(e);
  t === `ai-gateway-project` && (r = { ...r, checked: !0, hint: `Current` });
  let i = {
    value: `ai-gateway-key`,
    label: `AI Gateway via ${AI_GATEWAY_API_KEY_ENV_VAR}`,
    hint: `⎿ type your key`,
  };
  return (
    t === `ai-gateway-key` && (i = { ...i, checked: !0, hint: `Current` }),
    [
      r,
      i,
      {
        value: `chatgpt`,
        label: `ChatGPT subscription`,
        hint:
          t === `chatgpt` ? `Current` : `Authenticate through the Codex CLI`,
        checked: t === `chatgpt` || void 0,
      },
      {
        value: `external`,
        label: `Other providers`,
        hint: `Connect directly to a model provider
via OPENAI_API_KEY or ANTHROPIC_API_KEY.`,
      },
    ]
  );
}
async function selectProvider(e) {
  let t = {
    message: PROVIDER_QUESTION,
    options: e.options,
    initialValue: e.initialValue,
    validateInlineKey: e.validateInlineKey,
  };
  if (e.picker === void 0)
    throw Error(`The provider flow requires the Dev TUI provider picker.`);
  let n = await e.picker(t);
  if (n === void 0) throw new WizardCancelledError();
  return n;
}
async function runProviderFlow(t) {
  let { appRoot: n, prompter: o, signal: s } = t,
    c = {
      getVercelAuthStatus,
      runLinkFlow,
      appendEnv,
      validateGatewayApiKey,
      ...t.deps,
    },
    l,
    { availableProviders: u, selectedProvider: d } = t,
    f = d,
    p;
  try {
    for (;;) {
      let e = await selectProvider({
        picker: t.picker,
        options: providerOptions(l, d),
        initialValue: f,
        validateInlineKey: (e, t) =>
          c.validateGatewayApiKey(
            e,
            s === void 0 ? t : AbortSignal.any([s, t]),
          ),
      });
      if (e.kind === `external`)
        return (
          o.acknowledge
            ? await o.acknowledge({
                message: EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
                lines: EXTERNAL_PROVIDER_INSTRUCTIONS,
              })
            : o.note(
                EXTERNAL_PROVIDER_INSTRUCTIONS.join(`
`),
                EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
              ),
          { kind: `external-provider` }
        );
      if (e.kind === `chatgpt`) return e;
      if (e.kind === `ai-gateway-key`) {
        p = e;
        break;
      }
      if (d !== `ai-gateway-project` && u.includes(`ai-gateway-project`))
        return e;
      let r = await withSpinner(o, `Checking your Vercel login…`, () =>
        c.getVercelAuthStatus(n, { signal: s }),
      );
      if (
        (s?.throwIfAborted(), (l = r), vercelAuthBlockerReason(l) !== void 0)
      ) {
        f = `ai-gateway-key`;
        continue;
      }
      let a = await c.runLinkFlow({
        appRoot: n,
        prompter: o,
        signal: s,
        projectSelection: `create-or-link`,
      });
      return a.kind === `cancelled` ? a : { kind: `ai-gateway-project` };
    }
  } catch (e) {
    if (e instanceof WizardCancelledError) return { kind: `cancelled` };
    throw e;
  }
  let m = p.key.trim(),
    h = p.validation;
  (s?.throwIfAborted(),
    h.kind === `inconclusive` &&
      o.log.warning(
        `Couldn't reach the gateway to validate (${h.message}). Saving the key anyway.`,
      ));
  let g = await writeAiGatewayApiKey({
    projectRoot: n,
    apiKey: m,
    appendEnv: c.appendEnv,
  });
  return (o.log.success(`${g.envKey} set.`), { kind: `ai-gateway-key` });
}
export {
  EXTERNAL_PROVIDER_INSTRUCTIONS,
  EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
  PROVIDER_QUESTION,
  runProviderFlow,
};
