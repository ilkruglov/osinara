/**
 * The person's sleep and daily activity, in their private chat.
 *
 * Export:
 * - `manage_sleep_activity`: log a night or a day's steps and pulse, list, remove, import a Zepp
 *   export from the personal workspace.
 */
import { defineTool } from "eve/tools";

import {
  assertDatabaseJournal,
  healthError,
  inputInvalid,
} from "../health-journal/health-access.js";
import { sleepActivityInput } from "../health-journal/sleep-activity-input.js";
import { sleepActivityRepository } from "../health-journal/sleep-activity-repository.js";
import { parseZeppExport, ZeppExportError } from "../health-journal/zepp-export.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";

const IMPORT_FAILURES: Readonly<
  Record<ZeppExportError["reason"], { correction: string; reason: string }>
> = {
  corrupt: {
    correction:
      "Попроси человека заново выгрузить данные в приложении Zepp и прислать архив файлом.",
    reason: "Архив повреждён или это не zip",
  },
  too_large: {
    correction: "Попроси выгрузку за меньший период или пришли другой файл.",
    reason: "Архив или файл в нём слишком большой",
  },
  no_data: {
    correction: "Проверь, что это выгрузка Zepp (папки ACTIVITY, SLEEP, BODY), и спроси человека.",
    reason: "В архиве нет данных активности, сна или веса",
  },
  password_required: {
    correction:
      "Архив зашифрован: спроси у человека пароль, который приложение Zepp показало при выгрузке, и повтори с password.",
    reason: "Нужен пароль архива",
  },
  password_wrong: {
    correction: "Скажи человеку, что пароль не подошёл, и попроси проверить его в приложении Zepp.",
    reason: "Пароль архива не подошёл",
  },
  unsupported: {
    correction:
      "Скажи человеку, что этот формат выгрузки не поддерживается, и попроси выгрузку Zepp.",
    reason: "Формат архива не поддерживается",
  },
};

export default defineTool({
  description: [
    "Сон, шаги и пульс покоя человека (личный чат) — со слов, со скриншота приложения или из архива выгрузки Zepp. Не для тренировок и веса.",
    "log_sleep — ночь на день пробуждения, замена записанной ночи только с её version; log_activity — поля дня; list — до 31 дня; remove — kind и date.",
    "import_zepp — path к .zip в личном workspace и password, если архив зашифрован; записанное со слов импорт не трогает.",
  ].join(" "),
  inputSchema: sleepActivityInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    const operationKey = `${ctx.session.id}:${ctx.callId}`;
    if (input.action !== "import_zepp")
      return await sleepActivityRepository.execute(auth, input, operationKey);
    const parsed = sleepActivityInput.safeParse(input);
    // The schema requires the path of import_zepp; the archive is found in the personal workspace.
    if (!parsed.success || parsed.data.path === undefined)
      inputInvalid(
        "импорта",
        "manage_sleep_activity",
        ": path к .zip в личном workspace (glob inbox/**/*.zip)",
      );
    // A person keeping files is refused before the archive is read and decrypted, not after.
    await assertDatabaseJournal(auth, operationKey);
    const file = await workspaceBinaryRepository.readBinary(
      requireWorkspaceAuthorization(ctx),
      "personal",
      parsed.data.path,
    );
    let data;
    try {
      data = parseZeppExport(file.bytes, parsed.data.password ?? null);
    } catch (error) {
      if (!(error instanceof ZeppExportError)) throw error;
      const failure = IMPORT_FAILURES[error.reason];
      throw healthError(`AGENT_HEALTH_IMPORT_${error.reason.toUpperCase()}`, failure.reason, {
        category: error.reason === "password_required" ? "input" : "operation",
        correction: failure.correction,
        retryable: error.reason === "password_required",
      });
    }
    return await sleepActivityRepository.importZepp(
      auth,
      {
        contentSha256: file.file.contentSha256,
        path: file.file.path,
        since: parsed.data.since ?? null,
      },
      data,
      operationKey,
    );
  },
});
