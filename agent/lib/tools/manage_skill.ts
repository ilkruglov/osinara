/**
 * Owner-only library of Mia's authored skills.
 *
 * Export:
 * - `manage_skill`: list / read the family library, publish, roll back or retire a skill through
 *   Telegram HITL, grant or revoke it for an external group, and record how the last application
 *   of a skill went.
 *
 * Key constructs:
 * - A skill adds procedure, never rights: the rubric refuses tool names outside the current mode.
 * - Mutations run only after the exact Eve tool call was approved by the owner and the owner role
 *   was re-read from the database; the same call replayed after approval creates nothing twice.
 * - Published content is visible from the next turn: the dynamic resolver reads the library on
 *   `turn.started`, so the result says so instead of promising immediate availability.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { skillSelectionCaseSchema } from "../authored-skills/skill-selection.js";
import { skillEvaluationRepository } from "../authored-skills/skill-evaluation-repository.js";
import { skillCheckSchema } from "../authored-skills/skill-evaluation.js";
import { AppError } from "../app-error.js";
import {
  AUTHORED_SKILL_LIMITS,
  AUTHORED_SKILL_REQUIRED_SECTIONS,
  EVE_BUILTIN_TOOL_NAMES,
} from "../authored-skills/authored-skill-contract.js";
import {
  AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS,
  AUTHORED_SKILL_EXAMPLES_MAX,
  authoredSkillExampleRepository,
} from "../authored-skills/authored-skill-example-repository.js";
import { authoredSkillGrantRepository } from "../authored-skills/authored-skill-grant-repository.js";
import { authoredSkillRepository } from "../authored-skills/authored-skill-repository.js";
import { requireTrustedTelegramOwner, type TrustedTelegramOwner } from "../family-context.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";

const TOOL_DESCRIPTION = [
  "Библиотека собственных навыков Мии, одна на семью. Только владелец в личном или семейном чате. Сначала load_skill skill-authoring.",
  "list/read показывают навыки, примеры, черновики и usages с id, версией, оценкой владельца и отдельной технической статистикой. record_outcome требует name, usageId из read, outcome ok/failed и note; записывай только явную оценку владельца.",
  "Создание и улучшение: draft (name, description, markdown, files, changeNote) сохраняет неизменяемого кандидата. test_selection (candidateId, selectionCases:[{request,shouldLoad}]) проверяет выбор навыка в свежем контексте на 2–6 положительных и отрицательных запросах.",
  "Пробный прогон: begin_trial с candidateId, variant candidate/baseline, request (или exampleId сохранённого примера), checks:[{toolName,path,operator,expected}]. Операторы succeeded, nonempty, equals; path это ключи JSON в output инструмента. Задай проверки ДО выполнения; затем выполни пример и finish_trial с runId и trialSummary. Выполняй последовательными шагами, begin_trial отдельно от проверяемых инструментов. Служебный manage_skill не считается доказательством. cancel_trial с runId отменяет начатый прогон.",
  "Прогоны сами инструменты не запускают. Побочные действия только по явной просьбе владельца; при повторных проверках используй тестовые адресаты и файлы. Проверки доказывают наблюдаемое выполнение, качество принимает владелец.",
  "publish требует тот же контент, candidateId, успешный runId, trialRequest и trialSummary. Для обновления каждый сохранённый пример должен иметь baseline и успешный candidate с одинаковыми checks; trials:[{exampleId,summary}] остаются пояснением, не доказательством. Изменился контент или базовая версия: новый draft и проверки. Publish, rollback, retire, grant, revoke требуют кнопки владельца.",
  `Markdown без frontmatter; обязательные разделы: ${AUTHORED_SKILL_REQUIRED_SECTIONS.join(", ")}. Инструменты только текущего режима. До ${AUTHORED_SKILL_LIMITS.markdownMaxCharacters} символов, ${AUTHORED_SKILL_LIMITS.filesMax} файлов references/*.md по ${AUTHORED_SKILL_LIMITS.fileMaxCharacters}. Навык с generate_image требует reference с шаблоном промпта.`,
  "add_example: name, request, expected. remove_example: name, exampleId, только по просьбе владельца. rollback: name, version. retire: name. grant/revoke: name, group; права инструментов навык не добавляет. Опубликованный навык доступен со следующего хода.",
].join(" ");

const MUTATING_ACTIONS = new Set(["grant", "publish", "retire", "revoke", "rollback"]);

const manageSkillSchema = z.object({
  action: z.enum(["cancel_trial", "test_selection", "draft", "begin_trial", "finish_trial", "add_example", "grant", "list", "publish", "read", "record_outcome", "remove_example", "retire", "revoke", "rollback"]),
  selectionCases: z.array(skillSelectionCaseSchema).min(2).max(6).optional().describe("test_selection: положительные и отрицательные запросы для выбора навыка"),
  candidateId: z.uuid().optional().describe("begin_trial и publish: id неизменяемого черновика из draft"),
  runId: z.uuid().optional().describe("finish_trial и publish: id наблюдаемого прогона"),
  checks: z.array(skillCheckSchema).min(1).max(10).optional().describe("begin_trial: заранее заданные проверки output инструмента; path это массив ключей JSON"),
  variant: z.enum(["baseline", "candidate"]).optional().describe("begin_trial: текущая версия или черновик"),
  changeNote: z.string().max(AUTHORED_SKILL_LIMITS.changeNoteMaxCharacters).optional()
    .describe("publish: что изменилось и зачем"),
  description: z.string().max(AUTHORED_SKILL_LIMITS.descriptionMaxCharacters).optional()
    .describe("publish: триггер загрузки, задача плюс косвенные формулировки"),
  exampleId: z.uuid().optional().describe("remove_example: id примера из read"),
  expected: z.string().max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS).optional()
    .describe("add_example: каким должен быть правильный результат"),
  files: z.record(z.string(), z.string()).optional()
    .describe("publish: справочные файлы references/<имя>.md"),
  group: z.string().max(200).optional()
    .describe("grant, revoke: название внешней группы или её отрицательный chat id"),
  markdown: z.string().max(AUTHORED_SKILL_LIMITS.markdownMaxCharacters).optional()
    .describe("publish: тело SKILL.md без frontmatter"),
  name: z.string().max(40).optional().describe("Имя навыка: строчные латинские буквы, цифры, дефис"),
  note: z.string().max(500).optional().describe("record_outcome: что именно вышло не так или хорошо"),
  outcome: z.enum(["failed", "ok"]).optional().describe("record_outcome: исход последнего применения"),
  request: z.string().max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS).optional()
    .describe("add_example: запрос человека, на котором навык проверяется"),
  trialRequest: z.string().max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS).optional()
    .describe("publish: запрос, на котором выполнен пробный прогон; сохраняется как пример"),
  trials: z.array(z.object({
    exampleId: z.uuid(),
    summary: z.string().min(1).max(AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS),
  }).strict()).max(AUTHORED_SKILL_EXAMPLES_MAX).optional()
    .describe("publish версии 2+: прогон каждого сохранённого примера и что получилось"),
  trialSummary: z.string().max(AUTHORED_SKILL_LIMITS.trialSummaryMaxCharacters).optional()
    .describe("publish: что выполнено в пробном прогоне и что получилось"),
  usageId: z.uuid().optional().describe("record_outcome: id конкретного применения из read, обязательно"),
  version: z.number().int().min(1).optional().describe("read: версия; rollback: к какой версии вернуться"),
}).strict();

type ManageSkillInput = z.infer<typeof manageSkillSchema>;

function requireName(input: ManageSkillInput): string {
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new AppError("AGENT_SKILL_INPUT_INVALID", "Укажи name навыка");
  }
  return input.name;
}

function requireGroup(input: ManageSkillInput): string {
  if (typeof input.group !== "string" || input.group.trim().length === 0) {
    throw new AppError("AGENT_SKILL_INPUT_INVALID", "Укажи group: название внешней группы или её chat id");
  }
  return input.group;
}

function requireField(
  input: ManageSkillInput,
  key: "changeNote" | "description" | "expected" | "markdown" | "request" | "trialRequest" | "trialSummary",
  action = "publish",
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("AGENT_SKILL_INPUT_INVALID", `Для ${action} обязательно поле ${key}`);
  }
  return value;
}

/** Tool names the rubric accepts: the trusted catalog of this mode plus Eve built-ins. */
async function knownToolNames(owner: TrustedTelegramOwner): Promise<Set<string>> {
  // Lazy import: the catalog imports this tool, so a static import would be a cycle.
  const catalog = await import("../tool-policy/trusted-mode-tool-catalog.js");
  const modeOnly = owner.chatKind === "private" ? catalog.PRIVATE_ONLY_TOOL_NAMES : catalog.FAMILY_ONLY_TOOL_NAMES;
  return new Set([...catalog.TRUSTED_MODE_TOOL_NAMES, ...modeOnly, ...EVE_BUILTIN_TOOL_NAMES]);
}

export default defineTool({
  approval: ({ toolInput }) => {
    const action = (toolInput as { action?: unknown } | null)?.action;
    return typeof action === "string" && MUTATING_ACTIONS.has(action) ? "user-approval" : "not-applicable";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageSkillSchema,
  async execute(input, ctx) {
    const owner = requireTrustedTelegramOwner(ctx);
    const caller = { familyId: owner.familyId, role: owner.role, userId: owner.userId };
    const provenance = { eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id };
    const nextTurnNote = "Навык доступен со следующего хода";

    switch (input.action) {
      case "list":
        return {
          grants: await authoredSkillGrantRepository.grants(owner.familyId),
          skills: await authoredSkillRepository.list(owner.familyId),
        };
      case "grant": {
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillGrantRepository.grant(caller, { group: requireGroup(input), name: requireName(input) });
        return { ...result, note: result.granted ? "Навык доступен группе со следующего хода" : "Навык уже был выдан этой группе" };
      }
      case "revoke": {
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillGrantRepository.revoke(caller, { group: requireGroup(input), name: requireName(input) });
        return { ...result, note: "Группа больше не получает этот навык" };
      }
      case "read":
        return {
          ...await authoredSkillRepository.read(owner.familyId, requireName(input), input.version),
          candidates: await skillEvaluationRepository.list(owner.familyId, requireName(input)),
          usages: await authoredSkillRepository.usages(owner.familyId, requireName(input), await authoredSkillRepository.conversationId(owner)),
        };
      case "record_outcome": {
        if (input.outcome === undefined || input.usageId === undefined) {
          throw new AppError("AGENT_SKILL_INPUT_INVALID", "Для record_outcome укажи usageId из read и outcome: ok или failed");
        }
        const conversationId = await authoredSkillRepository.conversationId(owner);
        return await authoredSkillRepository.recordOutcome(caller, {
          conversationId, usageId: input.usageId, name: requireName(input), note: input.note ?? null, outcome: input.outcome,
        });
      }
      case "test_selection": {
        if (!input.candidateId || !input.selectionCases) throw new AppError("AGENT_SKILL_INPUT_INVALID", "Нужны candidateId и selectionCases");
        return await skillEvaluationRepository.testSelection(caller, input.candidateId, input.selectionCases);
      }
      case "begin_trial": {
        if (!input.candidateId || !input.checks || !input.variant) throw new AppError("AGENT_SKILL_INPUT_INVALID", "Нужны candidateId, checks, variant");
        return await skillEvaluationRepository.begin(caller, { ...provenance, candidateId: input.candidateId,
          exampleId: input.exampleId, request: input.request, checks: input.checks, variant: input.variant, operationKey: ctx.callId });
      }
      case "cancel_trial": {
        if (!input.runId) throw new AppError("AGENT_SKILL_INPUT_INVALID", "Нужен runId");
        return await skillEvaluationRepository.cancel(caller, input.runId, provenance);
      }
      case "finish_trial": {
        if (!input.runId) throw new AppError("AGENT_SKILL_INPUT_INVALID", "Нужен runId");
        return await skillEvaluationRepository.finish(caller, input.runId, provenance, requireField(input, "trialSummary", "finish_trial"));
      }
      case "draft":
      case "publish": {
        const draft = {
          changeNote: requireField(input, "changeNote"),
          description: requireField(input, "description"),
          files: input.files ?? {},
          markdown: requireField(input, "markdown"),
          name: requireName(input),
          trialSummary: input.action === "draft" ? "Пробный прогон ещё не выполнен" : requireField(input, "trialSummary"),
        };
        if (input.action === "draft") return await skillEvaluationRepository.draft(caller, draft, ctx.callId, await knownToolNames(owner));
        if (!input.candidateId || !input.runId) throw new AppError("AGENT_SKILL_EVAL_MISSING", "Сначала draft, begin_trial, выполнение, finish_trial; publish требует candidateId и runId");
        const trialRequest = requireField(input, "trialRequest");
        // Owner role and the exact Telegram approval are both revalidated at the mutation boundary.
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillRepository.publish(caller, draft, {
          knownToolNames: await knownToolNames(owner), operationKey: ctx.callId, provenance,
          evaluation: { candidateId: input.candidateId, runId: input.runId },
          trialRequest, trials: input.trials ?? [],
        });
        return { ...result, note: nextTurnNote };
      }
      case "add_example":
        return await authoredSkillExampleRepository.add(caller, {
          expected: requireField(input, "expected", "add_example"), name: requireName(input),
          request: requireField(input, "request", "add_example"),
        });
      case "remove_example": {
        if (input.exampleId === undefined) {
          throw new AppError("AGENT_SKILL_INPUT_INVALID", "Для remove_example укажи exampleId из read");
        }
        return await authoredSkillExampleRepository.remove(caller, { exampleId: input.exampleId, name: requireName(input) });
      }
      case "rollback": {
        if (input.version === undefined) {
          throw new AppError("AGENT_SKILL_INPUT_INVALID", "Для rollback укажи version, к которой вернуться");
        }
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillRepository.rollback(caller, {
          knownToolNames: await knownToolNames(owner), name: requireName(input),
          operationKey: ctx.callId, provenance, version: input.version,
        });
        return { ...result, note: nextTurnNote };
      }
      case "retire": {
        await requireToolApprovalEvidence(ctx, "manage_skill", input);
        const result = await authoredSkillRepository.retire(caller, { name: requireName(input) });
        return { ...result, note: "Навык убран из выдачи; история версий сохранена" };
      }
    }
  },
});
