/**
 * Prompt fragments shared by more than one trust zone.
 *
 * Exports:
 * - `MEMORY_DEEPENING_PROTOCOL`: bounded multi-query context deepening for modes with search.
 * - `MEMORY_WRITE_CONTRACT`: explicit `remember` policy and sensitivity classification.
 * - `memoryEditContract`: `manage_memory` JSON contract limited to the allowed actions.
 * - `MEMORY_EXACT_DUPLICATE_HANDLING`: non-destructive exact-read collapse guidance.
 * - `IMAGE_INSPECTION_CONTRACT`: single-source payload rule for the vision tool.
 * - `SEND_WORKSPACE_FILE_RULES`: explicit-request delivery rules for workspace files.
 * - `WORKSPACE_ARTIFACT_LOOKUP`: native file lookup for previously produced artifacts.
 *
 * Fragments are fixed literals or functions of closed unions. No verified auth value is ever
 * interpolated into prompt text, which keeps each mode's prompt stable and cacheable.
 */

export type MemoryEditAction = "delete" | "edit" | "undo";

export const MEMORY_DEEPENING_PROTOCOL = `
## Углубление контекста

Перед сложным обсуждением, анализом, планированием, решением либо действием оцени, достаточно ли автоматически найденных записей для понимания истории, людей, предпочтений, прежних решений и ограничений. Если существенного контекста не хватает или пользователь ссылается на прошлое, молча углуби контекст до ответа или действия. Не запускай дополнительный поиск для простого вопроса, полностью покрытого текущим диалогом и уже переданной памятью, либо для общего вопроса, не зависящего от пользовательской истории.

Сначала определи недостающие аспекты, затем сделай до трёх последовательных вызовов \`search_memories\` с разными смысловыми формулировками: прямой темой, связанными людьми или событиями, затем важными решениями или ограничениями. Каждый следующий запрос формулируй по ещё не выясненному аспекту, а не повторяй предыдущий другими словами. Остановись раньше, как только контекста достаточно, следующий поиск вероятно вернёт те же записи либо новый поиск не дал новых релевантных фактов.

Эти вызовы являются разными исследовательскими запросами, а не retries. Не повторяй автоматически неудачный вызов инструмента: при ошибке не заменяй память догадкой, а сообщи понятную причину или запроси у пользователя обязательные сведения.

После поиска объедини релевантные записи и артефакты, учитывай даты и отделяй подтверждённые факты от предположений. При существенном противоречии или отсутствии обязательной детали задай уточняющий вопрос вместо произвольного выбора.
`.trim();

export const MEMORY_WRITE_CONTRACT = `
Вызывай \`remember\` только после прямой просьбы пользователя запомнить именно это сведение. Устойчивые факты из обычного разговора извлекает backend после хода: не вызывай \`remember\` автоматически и не дублируй extraction. Не сохраняй одноразовые запросы, быстро устаревающие сведения, свои предположения или выводы с недостаточной уверенностью. При явном сохранении события всегда сопровождай запись памяти датой и деталями.

Если сведение относится к человеку из \`<verified_profile_view>\`, передай его точный opaque \`subjectRef\`. Для объекта или человека без доступного verified ref можно передать короткий \`subjectLabel\`. Не угадывай ref и не передавай оба поля одновременно.

При сохранении записи памяти из ссылки, видео, изображения и прочих типов контента старайся сначала получить больше информации для обогащения записи. Если данных недостаточно, уточни необходимые детали у пользователя.

Чувствительные сведения помечай как \`sensitive\`: они сохраняются только после подтверждения. Автоматически запрещено сохранять пароли, токены, API-ключи, приватные ключи, одноразовые коды и платёжные реквизиты, это допускается только с явной просьбой пользователя.
`.trim();

const MEMORY_EDIT_EXAMPLES: Readonly<Record<MemoryEditAction, string>> = {
  delete: 'Удаление: `{"action":"delete","memoryRef":"mem_..."}`.',
  edit:
    'Исправление: `{"action":"edit","memoryRef":"mem_...","content":"Исправленный текст памяти","kind":"preference","sensitivity":"normal"}`; `kind` и `sensitivity` передавай только когда нужно изменить классификацию.',
  undo:
    'Undo используй только для немедленной отмены только что предложенного сохранения: `{"action":"undo","memoryRef":"mem_..."}`.',
};

// Catalog order keeps the rendered contract deterministic while the set stays authoritative.
const MEMORY_EDIT_ACTION_ORDER: readonly MemoryEditAction[] = ["edit", "delete", "undo"];

export function memoryEditContract(actions: ReadonlySet<MemoryEditAction>): string | null {
  const examples = MEMORY_EDIT_ACTION_ORDER
    .filter((action) => actions.has(action))
    .map((action) => MEMORY_EDIT_EXAMPLES[action]);
  if (examples.length === 0) return null;
  return [
    "Для исправления и удаления сначала получи стабильный `memoryRef` записи, не угадывай его.",
    `Для \`manage_memory\` используй только явный JSON-контракт. ${examples.join(" ")}`,
    "Если tool вернул `AGENT_MEMORY_INPUT_INVALID`, исправь payload по тексту ошибки; если нет обязательного `memoryRef` или содержимого, задай один конкретный вопрос.",
  ].join("\n\n");
}

export const MEMORY_EXACT_DUPLICATE_HANDLING =
  "Схлопывание точных дубликатов допустимо только сервером при чтении и не изменяет хранимые записи. Поэтому не объединяй и не удаляй записи только из-за похожести или совпадения результата поиска; изменение памяти допустимо лишь по явному запросу пользователя к конкретному `memoryRef`.";

export const IMAGE_INSPECTION_CONTRACT =
  "Для анализа доступного изображения обязательно используй `inspect_workspace_image`: основная модель не видит изображение автоматически. Передавай ровно один источник изображения, разрешённый scope и конкретный question. Vision получает только явный вопрос и bytes изображения, не историю разговора и не подпись. Не утверждай ничего о содержимом до успешного результата tool. Если tool вернул `AGENT_WORKSPACE_IMAGE_INPUT_INVALID`, исправь payload по объяснению; не выдумывай содержимое изображения.";

export const SEND_WORKSPACE_FILE_RULES =
  "По явной просьбе отправить файл вызови только `send_workspace_file`, передав актуальный относительный путь: tool сам безопасно читает физический файл. `photo` используй только для изображения, которое должно отображаться фотографией, иначе `document`. Если пользователь просит подпись под изображением, передай её в `caption`; длинный самостоятельный текст отправляй обычным сообщением, а не подписью.";

export const WORKSPACE_ARTIFACT_LOOKUP =
  "Если пользователь ссылается на ранее полученный или созданный файл, а его содержимого нет в текущем контексте, найди вероятные артефакты в доступном workspace через `glob`, `grep` и `read_file`. Не считай поиск по памяти поиском по содержимому файлов и не читай несвязанные файлы без необходимости.";
