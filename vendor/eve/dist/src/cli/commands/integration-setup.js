import { serializeHeadlessSetupEvent } from "./setup-headless.js";
import { createPrompter } from "#setup/prompter.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { createHeadlessPrompter } from "#setup/headless.js";
import { SetupPrerequisiteRequired } from "#setup/integrations/shared/prerequisite.js";
import { createRegistrySetupClient } from "#setup/registry-setup-client.js";
import {
  InteractionRequired,
  InvalidAnswerError,
  headlessAsker,
  interactiveAsker,
  withAnswers,
  withPolicy,
} from "#setup/ask.js";
import { runIntegrationSetup } from "#setup/integrations/runner.js";
import { setupQuestionToWire } from "#setup/setup-question-wire.js";
const defaultIntegrationSetupDependencies = {};
async function runIntegrationSetupCommand(
  s,
  c,
  l,
  u = {},
  d = defaultIntegrationSetupDependencies,
) {
  let f = createRegistrySetupClient({
    process: d.setupProcess,
    signal: u.signal,
  });
  try {
    let n = u.nonInteractive === !0,
      r =
        f?.prompter ??
        d.createPrompter?.() ??
        (n ? createHeadlessPrompter(() => {}) : createPrompter()),
      i = n ? headlessAsker() : interactiveAsker(r),
      a = u.yes ? withPolicy(`assume`)(i) : i,
      o = await runIntegrationSetup(
        l,
        {
          appRoot: c,
          prompter: r,
          asker: withAnswers(u.answers ?? {})(a),
          resolveVercelProject: n
            ? void 0
            : () =>
                ensureVercelProject({
                  appRoot: c,
                  prompter: r,
                  signal: f?.signal ?? u.signal,
                }),
          signal: f?.signal ?? u.signal,
          beginExternalAction: n
            ? (e) => {
                let t = `external-action-${crypto.randomUUID()}`;
                return (
                  s.log(
                    serializeHeadlessSetupEvent({
                      version: 1,
                      type: `external_action`,
                      id: t,
                      blocking: !0,
                      ...e,
                    }),
                  ),
                  {
                    complete() {
                      s.log(
                        serializeHeadlessSetupEvent({
                          version: 1,
                          type: `external_action_resolved`,
                          id: t,
                        }),
                      );
                    },
                  }
                );
              }
            : void 0,
        },
        d.runnerDeps,
      );
    if (o.kind === `cancelled`) {
      (f?.cancel(),
        process.env.EVE_SETUP === `1`
          ? (process.exitCode = 130)
          : n &&
            s.error(
              serializeHeadlessSetupEvent({
                version: 1,
                type: `cancelled`,
                item: l,
              }),
            ));
      return;
    }
    (r.outro(`Integration set up.`),
      f?.complete(o.completion),
      n &&
        f === void 0 &&
        s.log(
          serializeHeadlessSetupEvent({
            version: 1,
            type: `completed`,
            item: l,
          }),
        ));
  } catch (e) {
    if ((f?.fail(e), f !== void 0)) return;
    u.nonInteractive && e instanceof InteractionRequired
      ? (s.error(
          serializeHeadlessSetupEvent({
            version: 1,
            type: `blocked`,
            status: `input_required`,
            question: setupQuestionToWire(e.question),
          }),
        ),
        (process.exitCode = 2))
      : u.nonInteractive && e instanceof InvalidAnswerError
        ? (s.error(
            serializeHeadlessSetupEvent({
              version: 1,
              type: `blocked`,
              status: `input_required`,
              question: setupQuestionToWire(e.question),
              issue: { code: `invalid_answer`, message: e.message },
            }),
          ),
          (process.exitCode = 2))
        : u.nonInteractive && e instanceof SetupPrerequisiteRequired
          ? (s.error(
              serializeHeadlessSetupEvent({
                version: 1,
                type: `blocked`,
                status: `prerequisite_required`,
                prerequisite: e.prerequisite,
              }),
            ),
            (process.exitCode = 2))
          : (s.error(e instanceof Error ? e.message : String(e)),
            (process.exitCode = 1));
  }
}
export { runIntegrationSetupCommand };
