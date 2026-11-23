/**
 * `manage_skill` keeps no key in anything the model hands it.
 *
 * Constructs covered:
 * - One walk over the whole input refuses every text a skill stores or sends on: `publish`
 *   (`trialRequest`, `trials[].summary`, `files`), `add_example`, `begin_trial` (the request and
 *   `checks[].expected`), `finish_trial`, `record_outcome`, `test_selection` and the protocol of
 *   `create_experiment` (requests, files, checks, a fixture's `{"api_key": "…"}` pair).
 * - Each refusal is a correctable input error `AGENT_SKILL_SECRET_REJECTED` (nothing started, retry
 *   allowed) with `SKILL_SECRET_PROBLEM` and the path to the field; a key in a field name is named
 *   by its object, never echoed. A password told in words is refused like a key.
 * - Through the model-facing wrapper the refusal keeps that contract instead of becoming an
 *   operation of unknown outcome.
 * - The check comes first: the context throws on any read, so a refusal proves nothing before it
 *   ran, and a clean input reaches the context.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it } from "vitest";

import { wrapModelFacingTool } from "../model-facing-tool.js";
import { TRUSTED_MODE_TOOLS } from "../tool-policy/trusted-mode-tool-catalog.js";
import manageSkill from "../tools/manage_skill.js";
import { SKILL_SECRET_PROBLEM } from "./authored-skill-contract.js";
import { experimentProtocolSchema } from "./skill-experiment.js";

type ManageSkillInput = Parameters<typeof manageSkill.execute>[0];

const KEY = "FAL_KEY=abcdefghij0123456789";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const EXAMPLE_ID = "00000000-0000-4000-8000-000000000003";

const contextReached = (): never => {
  throw new Error("AGENT_TEST_CONTEXT_REACHED");
};
/** Every member throws: authorization, approval and the database all start from the context. */
const untouchedContext: ToolContext = {
  get abortSignal() {
    return contextReached();
  },
  get callId() {
    return contextReached();
  },
  get session() {
    return contextReached();
  },
  get toolName() {
    return contextReached();
  },
  getSandbox: contextReached,
  getSkill: contextReached,
  getToken: contextReached,
  requireAuth: contextReached,
};

/** Only the turn's identity is readable: the wrapper keys its repeat guard on it. */
const turnOnlyContext: ToolContext = {
  get abortSignal() {
    return contextReached();
  },
  get callId() {
    return contextReached();
  },
  session: {
    get auth() {
      return contextReached();
    },
    id: "wrun_skill_secret",
    turn: { id: "turn_skill_secret", sequence: 1 },
  },
  get toolName() {
    return contextReached();
  },
  getSandbox: contextReached,
  getSkill: contextReached,
  getToken: contextReached,
  requireAuth: contextReached,
};

const publish = {
  action: "publish",
  candidateId: CANDIDATE_ID,
  changeNote: "Первая версия",
  description: "Отчёт из файла, сводка, выжимка",
  files: { "references/report.md": "Шаблон отчёта" },
  markdown:
    "## Когда применять\nДля отчёта.\n## Шаги\n1. Вызови `read_file`.\n2. Вызови `write_file`.\n## Проверка результата\nПроверь файл.",
  name: "file-report",
  runId: RUN_ID,
  trialRequest: "Сделай отчёт",
  trialSummary: "Отчёт записан",
  trials: [{ exampleId: EXAMPLE_ID, summary: "Отчёт записан" }],
} satisfies ManageSkillInput;

const beginTrial = {
  action: "begin_trial",
  candidateId: CANDIDATE_ID,
  checks: [{ operator: "succeeded", path: [], toolName: "write_file" }],
  request: "Сделай отчёт",
  variant: "candidate",
} satisfies ManageSkillInput;

const experimentCase = (partition: "development" | "holdout") => ({
  checks: [{ path: "/workspace/result.txt", text: "42" }],
  files: {},
  id: partition,
  partition,
  request: `Задача ${partition}`,
});

/** A valid protocol, its first case changed; Eve parses the input before `execute` sees it. */
function experiment(change: object = {}, environment?: "scenario"): ManageSkillInput {
  return {
    action: "create_experiment",
    name: "file-report",
    protocol: experimentProtocolSchema.parse({
      cases: [{ ...experimentCase("development"), ...change }, experimentCase("holdout")],
      ...(environment === undefined ? {} : { environment }),
    }),
  };
}

const fixture = (input: Record<string, string>) => ({
  toolFixtures: [{ input, output: "Test page", toolName: "web_fetch" }],
});

const refusal = (field: string, reason = `${field}: ${SKILL_SECRET_PROBLEM}`) => ({
  code: "AGENT_SKILL_SECRET_REJECTED",
  contract: {
    category: "input",
    code: "AGENT_SKILL_SECRET_REJECTED",
    correction: expect.stringContaining("Убери"),
    field,
    reason,
    retryable: true,
    sideEffectStatus: "not_started",
  },
});

describe("manage_skill secret check", () => {
  it.each<[string, ManageSkillInput]>([
    ["trialRequest", { ...publish, trialRequest: `Сделай отчёт, ${KEY}` }],
    ["trialSummary", { ...publish, trialSummary: "Вошла, пароль Qwerty123" }],
    [
      "trials[2].summary",
      {
        ...publish,
        trials: [
          ...publish.trials,
          { exampleId: EXAMPLE_ID, summary: "Прошло" },
          { exampleId: EXAMPLE_ID, summary: `Ответ содержал ${KEY}` },
        ],
      },
    ],
    ['files["references/report.md"]', { ...publish, files: { "references/report.md": KEY } }],
    [
      "request",
      { action: "add_example", expected: "Отчёт записан", name: "file-report", request: KEY },
    ],
    [
      "expected",
      { action: "add_example", expected: KEY, name: "file-report", request: "Сделай отчёт" },
    ],
    ["request", { ...beginTrial, request: `Отчёт, ${KEY}` }],
    [
      "checks[1].expected",
      {
        ...beginTrial,
        checks: [
          ...beginTrial.checks,
          { expected: `Ответ: ${KEY}`, operator: "equals", path: ["text"], toolName: "read_file" },
        ],
      },
    ],
    // A card number as a JSON number is still a card number.
    [
      "checks[0].expected",
      {
        ...beginTrial,
        checks: [{ expected: 4111111111111111, operator: "equals", path: [], toolName: "x" }],
      },
    ],
    ["trialSummary", { action: "finish_trial", runId: RUN_ID, trialSummary: `Готово, ${KEY}` }],
    [
      "note",
      {
        action: "record_outcome",
        name: "file-report",
        note: `Сработало, ${KEY}`,
        outcome: "ok",
        usageId: RUN_ID,
      },
    ],
    [
      "selectionCases[0].request",
      {
        action: "test_selection",
        candidateId: CANDIDATE_ID,
        selectionCases: [
          { request: `Сделай отчёт, ${KEY}`, shouldLoad: true },
          { request: "Какая погода?", shouldLoad: false },
        ],
      },
    ],
    ["protocol.cases[0].request", experiment({ request: `Отчёт, ${KEY}` })],
    [
      'protocol.cases[0].files["/workspace/in.txt"]',
      experiment({ files: { "/workspace/in.txt": "пароль: abcdefgh12" } }),
    ],
    [
      "protocol.cases[0].checks[0].text",
      experiment({ checks: [{ target: "answer", text: "Bearer abcdefghijklmnop1234" }] }),
    ],
    // Neither half is a key alone; as the JSON pair they are.
    [
      "protocol.cases[0].toolFixtures[0].input.api_key",
      experiment(fixture({ api_key: "abcdefghijklmnop" }), "scenario"),
    ],
    [
      "protocol.cases[0].toolFixtures[0].input.token",
      experiment(fixture({ token: "abcdefghijklmnop" }), "scenario"),
    ],
    // Repeat review, 23 November 2026: the pair was rebuilt unescaped, and a quote or a line break
    // in the value cut the literal short.
    [
      "protocol.cases[0].toolFixtures[0].input.token",
      experiment(fixture({ token: 'abc"defghijklmnop' }), "scenario"),
    ],
    [
      "protocol.cases[0].toolFixtures[0].input.password",
      experiment(fixture({ password: "first line\nsecond line" }), "scenario"),
    ],
  ])("refuses a key in %s before anything else runs", async (field, input) => {
    await expect(manageSkill.execute(input, untouchedContext)).rejects.toMatchObject(
      refusal(field),
    );
  });

  // The exact message is the proof that the key itself is not echoed.
  it("names the object of a key that is a field name without echoing it", async () => {
    await expect(
      manageSkill.execute(experiment(fixture({ [KEY]: "x" }), "scenario"), untouchedContext),
    ).rejects.toMatchObject(
      refusal(
        "protocol.cases[0].toolFixtures[0].input",
        `protocol.cases[0].toolFixtures[0].input (имя поля): ${SKILL_SECRET_PROBLEM}`,
      ),
    );
  });

  // The definition the trusted surface wraps, as the model meets it.
  it("reaches the model as a correctable input error, not an unknown outcome", async () => {
    const definition = TRUSTED_MODE_TOOLS.manage_skill;
    if (definition === undefined) throw new Error("manage_skill left the trusted catalog");
    const wrapped = wrapModelFacingTool("manage_skill", definition);

    await expect(
      wrapped.execute({ ...publish, trialRequest: `Сделай отчёт, ${KEY}` }, turnOnlyContext),
    ).rejects.toMatchObject(refusal("trialRequest"));
  });

  it.each<[string, ManageSkillInput]>([
    ["publish", publish],
    ["begin_trial", beginTrial],
    ["create_experiment", experiment(fixture({ url: "https://example.com" }), "scenario")],
    // Repeat review, 23 November 2026: the pair check read a field as JSON, and the closing `"}`
    // (or an escaped line break) made the word after «пароль» look like a password.
    [
      "publish about a password",
      {
        ...publish,
        description: "Помогает сменить пароль роутера",
        markdown: publish.markdown.replace("Для отчёта.", "Сбрось пароль администратора\nи войди."),
      },
    ],
    // A template with an empty assignment: the pair under a plain field is not read as one, or the
    // escaped line break became the value (repeat review, 23 November 2026).
    [
      "add_example with an empty FAL_KEY= line",
      {
        action: "add_example",
        expected: "Шаблон",
        name: "file-report",
        request: "FAL_KEY=\nследующая строка",
      },
    ],
    [
      "create_experiment with a .env template",
      experiment(
        { files: { "/workspace/tokens.env": "FAL_KEY=\nTELEGRAM_BOT_TOKEN=\n" } },
        "scenario",
      ),
    ],
    [
      "add_example quoting a key's name inside a plain field",
      {
        action: "add_example",
        expected: "Шаблон",
        name: "file-report",
        request: "В шаблоне: 'token': '   \n    '",
      },
    ],
    [
      "create_experiment with a variable in a fixture",
      experiment(fixture({ token: "${FAL_KEY}" }), "scenario"),
    ],
    [
      "add_example with a template at the end of a sentence",
      {
        action: "add_example",
        expected: "Шаблон",
        name: "file-report",
        request: "Пример: FAL_KEY=$FAL_KEY.",
      },
    ],
    [
      "add_example about a password",
      {
        action: "add_example",
        expected: "Совет по длине",
        name: "file-report",
        request: "Какой пароль поставить?",
      },
    ],
  ])("lets a clean %s through to authorization", async (_action, input) => {
    await expect(manageSkill.execute(input, untouchedContext)).rejects.toThrow(
      "AGENT_TEST_CONTEXT_REACHED",
    );
  });
});
