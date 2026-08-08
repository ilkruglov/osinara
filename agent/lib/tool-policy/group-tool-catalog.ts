/**
 * External Telegram group capability catalog.
 *
 * Exports:
 * - `EXTERNAL_GROUP_CAPABILITY_CATALOG`: persisted capabilities with model usage metadata.
 * - `SANDBOX_FILE_CAPABILITY_CATALOG`: same-name guarded Eve capabilities for group workspaces.
 * - Derived capability-name tuples used by validation and execution policy.
 * - `FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS`: Eve built-ins overridden fail-closed externally.
 * - `ExternalGroupToolName`: validated persisted allowlist value.
 * - `parseExternalGroupToolAllowlist`: validates the complete persisted policy atomically.
 */
interface ExternalGroupCapability<Name extends string = string> {
  readonly name: Name;
  readonly usage: string;
}

function capabilityNames<const Catalog extends readonly ExternalGroupCapability[]>(
  catalog: Catalog,
): { readonly [Index in keyof Catalog]: Catalog[Index]["name"] } {
  return catalog.map(({ name }) => name) as {
    readonly [Index in keyof Catalog]: Catalog[Index]["name"];
  };
}

// Persisted grants are action-level where one static descriptor contains distinct side effects.
export const EXTERNAL_GROUP_CAPABILITY_CATALOG = [
  {
    name: "inspect_workspace_image",
    usage: "анализировать изображение, уже находящееся в workspace текущей группы",
  },
  { name: "list_memories", usage: "постранично читать память текущей группы" },
  { name: "list_memory_threads", usage: "постранично читать нити памяти текущей группы" },
  {
    name: "list_group_history",
    usage: "читать и фильтровать сохранённую историю текущей Telegram-группы",
  },
  {
    name: "manage_memory.delete",
    usage: "безвозвратно удалить найденную по ID запись памяти текущей группы",
  },
  {
    name: "manage_memory.edit",
    usage: "изменить содержимое или классификацию найденной по ID записи памяти текущей группы",
  },
  {
    name: "manage_memory.undo",
    usage: "немедленно отменить только что выполненное сохранение памяти по возвращённому ID",
  },
  {
    name: "manage_memory_conflict",
    usage: "после явного подтверждения разрешить показанный конфликт памяти текущей группы",
  },
  {
    name: "manage_memory_thread.complete",
    usage: "явно завершить нить текущей группы по проверенному событию и source refs",
  },
  {
    name: "manage_memory_thread.reactivate",
    usage: "явно реактивировать завершённую нить текущей группы",
  },
  { name: "read_memory_thread", usage: "читать bounded source-backed историю нити текущей группы" },
  { name: "remember", usage: "сохранить одну запись в память текущей группы" },
  {
    name: "remove_group_file",
    usage: "после подтверждения безвозвратно удалить файл из workspace текущей группы",
  },
  {
    name: "search_memories",
    usage: "найти по словам и смыслу записи памяти текущей группы",
  },
  { name: "search_memory_threads", usage: "искать нити памяти текущей группы по смыслу" },
  {
    name: "send_workspace_file",
    usage: "отправить файл из workspace в текущий Telegram-чат или тему",
  },
  {
    name: "web_fetch",
    usage: "безопасно загрузить текст HTTP(S)-страницы через контролируемый сетевой шлюз",
  },
] as const satisfies readonly ExternalGroupCapability[];

export const EXTERNAL_GROUP_TOOL_NAMES = capabilityNames(
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
);
export type ExternalGroupToolName = (typeof EXTERNAL_GROUP_TOOL_NAMES)[number];

// Same-name wrappers preserve Eve's native contracts while adding live authorization and exact
// group-root confinement. They remain baseline capabilities and need no persisted grant.
export const SANDBOX_FILE_CAPABILITY_CATALOG = [
  { name: "glob", usage: "найти пути файлов в /workspace/group по glob-шаблону" },
  { name: "grep", usage: "найти текст внутри файлов в /workspace/group" },
  { name: "read_file", usage: "прочитать файл из /workspace/group" },
  { name: "write_file", usage: "создать или изменить файл в /workspace/group" },
] as const satisfies readonly ExternalGroupCapability[];

export const ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES = capabilityNames(
  SANDBOX_FILE_CAPABILITY_CATALOG,
);

// Application tools are emitted per mode, so an external group never sees a descriptor it cannot
// use. Eve 0.22.5 allows same-name overrides but not per-mode removal, so forbidden built-ins still
// receive explicit denial definitions while file built-ins receive guarded same-name wrappers.
// `web_fetch` is conditionally denied because a local controlled override is grantable.
// Provider-native `web_search` has no execution hook and therefore stays unconditionally denied.
export const FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS = [
  "ask_question",
  "bash",
  "todo",
  "web_fetch",
  "web_search",
] as const;

export function isExternalGroupToolName(value: string): value is ExternalGroupToolName {
  return (EXTERNAL_GROUP_TOOL_NAMES as readonly string[]).includes(value);
}

export function parseExternalGroupToolAllowlist(
  value: unknown,
): ReadonlySet<ExternalGroupToolName> | null {
  if (!Array.isArray(value)) return null;

  // One unknown or duplicate entry invalidates the complete trusted policy rather than granting a
  // known subset. Registration rejects both shapes, so seeing either means persisted corruption.
  const allowed = new Set<ExternalGroupToolName>();
  for (const name of value) {
    if (typeof name !== "string" || !isExternalGroupToolName(name) || allowed.has(name)) return null;
    allowed.add(name);
  }
  return allowed;
}
