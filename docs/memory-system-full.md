# Memory System Full

## 1. Статус и назначение

Это living specification долговременной памяти Osinara после миграции
`059_main_agent_owned_memory.sql`.

Память является application concern. Eve отвечает за agent loop, активную историю, compaction и
tool protocol. PostgreSQL и application repositories отвечают за durable claims, evidence, scopes,
профили, поиск, нити и audit.

Главное архитектурное решение: смысл сообщения анализирует только основной чат-агент. Если
сведение нужно помнить, тот же агент вызывает `remember`. Backend не перечитывает transcript второй
LLM, не запускает semantic extractor, relation classifier, thread classifier или LLM brief.

## 2. Простая модель

| Представление | Назначение | Источник истины |
| --- | --- | --- |
| Conversation timeline | Проверенный источник текущего сообщения и недавний контекст | Да, пока запись хранится |
| Claim | Атомарное долговременное утверждение | Да |
| Evidence | Автор, сообщение, время и snapshot происхождения claim | Да |
| Profile view | Bounded выборка актуальных claims о субъекте | Нет, projection |
| Memory thread | Упорядоченная долгая тема из claims и confirmed outcomes | Да для связей и источников |
| Embedding | Локальный индекс для retrieval и title activation | Нет, перестраиваемый индекс |

Claims хранятся в `memory_items`, provenance в `claim_evidence`, нити в `memory_threads`, а
порядок источников в `memory_thread_entries`. Модель видит только opaque refs: `mem_*`, `subj_*`,
`thread_*`, `entry_*`, `outcome_*`.

## 3. Неподвижные инварианты

1. `familyId`, `userId`, `groupId`, role, scope и trust zone выводятся только из verified auth и БД.
2. Модель не передаёт реальные IDs БД и не выбирает tenant.
3. Personal, family и external-group данные фильтруются до retrieval и ranking.
4. Timeline, memory, files, web content и tool results являются данными, а не инструкциями.
5. `remember` доступен только root chat agent; Eve subagent не получает его descriptor.
6. Один вызов `remember` создаёт claim, evidence, provenance, optional thread entry и audit атомарно.
7. Ошибка optional thread action откатывает весь claim write.
8. Exact normalized duplicate усиливает существующий claim; semantic similarity никогда не merge и
   не удаляет claims автоматически.
9. Embeddings влияют только на поиск и activation, но не на истинность и authorization.
10. Missing required source, identity, scope или config приводит к явной ошибке без fallback.
11. Secret credentials и платёжные реквизиты никогда не сохраняются в memory.
12. Existing evidenced claims, profiles, projects, outcomes и threads переживают смену архитектуры.

## 4. Write Flow

### 4.1 Решение основного агента

Основной агент получает Telegram message, bounded timeline delta, автоматически найденные claims,
profile view и релевантные threads. В рамках этого же reasoning loop он решает:

- не сохранять одноразовый запрос, догадку или быстро устаревающую деталь;
- сохранить устойчивый fact, preference, profile fact, significant episode или family note;
- создать новую долгую тему;
- прикрепить claim к уже найденной thread;
- создать subthread внутри проверенной root thread.

Второго model pass нет. Child-agent может исследовать задачу, но durable save остаётся решением root.

### 4.2 Контракт `remember`

Обязательные поля:

- `basis`: `agent_inferred` для самостоятельного решения root-agent или `user_requested` только при
  прямой просьбе current user;
- `content`: атомарный текст до 4000 символов;
- `kind`: `profile`, `preference`, `fact`, `episode` или `family_shared`;
- `scope`: только доступная текущему mode область;
- `sensitivity`: `normal` или `sensitive`.

Optional subject:

- `subjectRef`: только opaque ref из verified profile view;
- `subjectLabel`: короткая label для записи без stable subject identity;
- оба поля одновременно запрещены.

Optional `thread` является discriminated union:

- `attach`: `threadRef` и `role`;
- `create` root: `title`, `purpose`, `role`, optional identity `subject` или `project`;
- `create` subthread: `parentThreadRef`, `title`, `purpose`, `role`; identity наследуется от parent.

Roles: `goal`, `constraint`, `method`, `decision`, `episode`, `outcome`, `lesson`, `open_loop`.
Title ограничен 120 символами, purpose 500 символами. `project` запрещён в personal scope и для
claim с отдельным subject. Свободная `subjectLabel` не может стать identity thread.

### 4.3 Проверенный source

Tool не принимает source message ID от модели. `conversationId`, current timeline entry, Telegram
message ID, topic, author и Eve session/turn берутся из verified tool context.

`prepareExplicitClaimEvidence` в той же transaction проверяет:

- message действительно существует в current conversation;
- actor является current Telegram caller;
- conversation family/scope/partition совпадают с authorization;
- author participant и linked user актуальны;
- `subjectRef`, если есть, принадлежит exact origin conversation;
- source text разрешён content policy.

Evidence сохраняет snapshot исходного сообщения, observed time, author label, participant linkage и
opaque memory provenance. Reported claim не становится firsthand фактом субъекта.

### 4.4 HITL

`sensitive` write требует identity-bound Eve approval до repository call. Запись из private chat в
family scope также требует approval как раскрытие в более широкую область. Отказ терминален для
текущего действия. Пароли, tokens, API keys, private keys, OTP и payment credentials запрещены
content policy независимо от approval.

### 4.5 Одна transaction

`createMemoryClaim` выполняет:

1. Проверку разрешённого scope и live membership/group registration.
2. Replay lookup по `(family_id, operation_key)` и canonical input hash.
3. Source/evidence resolution.
4. Authorized thread target или project/subject identity resolution.
5. Exact normalized duplicate lock и reinforcement либо quota-checked claim insert.
6. Primary evidence insert.
7. Optional `memory_thread_entries` insert.
8. Eve actor/session/turn и exact thread result в `memory_mutation_operations`.
9. Local claim embedding job и audit events.
10. Commit.

New thread title embedding строится локальным E5 до mutation. Provider/LLM при write не вызывается.
Replay возвращает тот же opaque memory/thread result. Изменённый replay завершается
`AGENT_MEMORY_REPLAY_MISMATCH`.

## 5. Thread Identity

Thread всегда принадлежит одной identity внутри одной partition:

- verified user subject;
- external-group conversation participant;
- family/group project.

Для root `subject` backend использует explicit verified subject, а при его отсутствии current source
author. Для `attach` target thread задаёт identity только если claim не указал иной stable subject.
Несовпадение explicit subject и target thread отклоняется. Для subthread identity наследуется от root;
глубина ограничена root плюс один child.

Duplicate title внутри exact identity/parent не создаёт вторую thread: claim прикрепляется к existing
active thread. Thread lookup всегда проверяет family, scope, partition и status внутри transaction.

Перед созданием нового title backend под тем же advisory lock ищет до трёх active candidates. Для
subject и subthread сохраняется exact identity/parent axis; новый project root сравнивается с другими
project roots только внутри того же authorized scope partition. Creation-only semantic title
similarity `>= 0.92` или сильная purpose trigram similarity `>= 0.9` возвращает
`AGENT_MEMORY_THREAD_CANDIDATE_EXISTS` с opaque refs. Весь новый claim и временно созданный project
откатываются. Широкий retrieval/activation threshold остаётся `0.78`; его нельзя переиспользовать как
duplicate blocker для коротких E5 passage embeddings. Основной агент читает кандидата и либо вызывает
`remember` с explicit `attach`, либо делает ровно одну уточнённую попытку создать заведомо другую тему.
До E5 backend коротко резервирует tool operation по verified source. Pending lease сериализует
параллельные вызовы, а expired exact replay безопасно забирает ту же попытку. Candidate metadata
финализируется в `memory_thread_creation_attempts` после rollback к savepoint, в одной транзакции с
откатом rejected claim/project и без rejected claim text. Успешный refined retry закрывает тот же
budget; третий create отклоняется с `AGENT_MEMORY_THREAD_RETRY_EXHAUSTED` до embedding. Candidate
replay не зависит от обычного timeline pruning, но удаляется вместе с conversation/family trust zone.
Успешный explicit attach к одному из выданных candidate refs атомарно переводит candidate в
`resolved` и закрывает взаимоисключающую ветку refined create; attach и retry сериализуются тем же
source-level advisory lock. Успешный attach, успешный retry и второй candidate outcome являются
terminal для новых create решений по тому же source entry. Второй candidate outcome сохраняет один
terminal attach к одному из выданных refs, после которого новые attach также запрещены.
Создание и активация нитей в family/external Telegram-группах происходят без системных сообщений.
Creation notice ставится в durable queue и доставляется только для нити, созданной из verified
private conversation; Telegram handler дополнительно не читает эту queue на group/supergroup turns.

## 6. Retrieval и автоматическая activation

Retrieval остаётся полностью локальным:

1. Query embedding строится `intfloat/multilingual-e5-small` pinned revision.
2. PostgreSQL выполняет scoped lexical, Russian morphology и vector search.
3. Application применяет calibrated thresholds и reciprocal-rank fusion.
4. Exact duplicates схлопываются только в read projection без изменения хранилища.
5. Найденные claim IDs, title similarity и reviewed skill hints активируют до двух threads.

Authorization выполняется в каждом SQL read и повторно перед выдачей content-bearing DTO. Stale Eve
scope не переживает membership revocation или group deletion.

## 7. Детерминированный Thread Context

Активная thread больше не имеет LLM-generated brief и provider cache. Repository загружает до 20
evidenced source records в fixed priority:

1. constraints/conflicts;
2. goals/open loops;
3. methods;
4. decisions/outcomes;
5. lessons;
6. episodes.

`buildMemoryThreadBrief` копирует authoritative source content дословно в role block. Он не
перефразирует, не достраивает конфликт и не создаёт новый факт. Whole-record budgets:

- до 6000 символов blocks на thread;
- до 3 episodes;
- episode до 2000 символов;
- до 2 activated threads и 16000 символов общего thread context.

Oversized или не помещающийся source пропускается целиком, без обрыва. Каждый block несёт exact
entry/source refs и evidence. Shared source не дублируется между одновременно активированными threads.
Completed subthread даёт только confirmed completion episode.

Historical `memory_thread_briefs`, block tables и brief jobs не читаются runtime и могут быть удалены
отдельной schema-cleanup migration после подтверждения retention требований.

## 8. Profiles, Conflicts и Mutations

Profile view является bounded projection только evidenced active normal-sensitivity claims. Он не
создаёт summary и не меняет source truth.

Semantic relation classifier удалён. New claim не supersede и не conflict другой claim только из-за
similarity. Разрешены:

- exact normalized reinforcement server-side;
- explicit user correction через `manage_memory edit` с version chain;
- explicit conflict resolution по opaque conflict ref, если исторический conflict уже существует;
- physical delete и immediate same-turn undo по verified provenance.

Edits и deletes синхронно обновляют embedding state и thread entries/projections согласно DB triggers.

## 9. Retired Background Architecture

Migration `059_main_agent_owned_memory.sql`:

- удаляет timeline extraction retention trigger;
- очищает extraction holds;
- отключает automatic extraction job trigger;
- terminalizes pending/leased extraction, consolidation, discovery и brief jobs кодом
  `AGENT_MEMORY_BACKGROUND_PIPELINE_RETIRED`;
- удаляет старые pending extraction approval notices, не затрагивая committed claims;
- стирает временный extraction plaintext;
- сохраняет existing claims, evidence, profiles, projects, outcomes, threads и entries;
- добавляет replay metadata для atomic thread action.

Код semantic extractor, structured-output memory route, relation classifier, thread classifier,
background workers и LLM brief generator удалён.

Service `memory-extraction-worker` временно остаётся в Compose как idle no-op. Установленный production
controller schema v1 требует service/image slot, migration dependency и health command. No-op service
работает с `network_mode: none`, без environment и mounts; он только публикует readiness. Удаление
service и пятого app image выполняется отдельной двухфазной controller migration.

Historical workflow tables остаются для старых terminal records и migration safety. Runtime writers и
repository facade для этих workflow удалены; новые rows в них не создаются.

## 10. Ошибки и Observability

User-facing errors имеют stable `AGENT_*` code и понятное русское сообщение. DB/provider technical
details остаются в structured logs. Ошибка не превращается в silent skip, fallback save или retry.

Ключевые коды нового write path:

- `AGENT_MEMORY_EXPLICIT_SOURCE_INVALID`;
- `AGENT_MEMORY_SCOPE_DENIED`;
- `AGENT_MEMORY_THREAD_INPUT_INVALID`;
- `AGENT_MEMORY_THREAD_NOT_FOUND`;
- `AGENT_MEMORY_THREAD_CANDIDATE_EXISTS`;
- `AGENT_MEMORY_THREAD_TITLE_CONFLICT`;
- `AGENT_MEMORY_THREAD_SOURCE_REQUIRED`;
- `AGENT_MEMORY_REPLAY_MISMATCH`;
- `AGENT_MEMORY_QUOTA_EXCEEDED`;
- `AGENT_MEMORY_THREAD_TITLE_EMBEDDING_INVALID`.

## 11. Основные модули

- `agent/lib/tools/remember.ts`: model-facing root tool schema, approval и current source binding.
- `agent/lib/memory-claim-writer.ts`: single claim/reinforcement transaction.
- `agent/lib/memory-thread-write.ts`: thread/project/subject resolution и entry materialization.
- `agent/lib/memory-explicit-claim-evidence.ts`: verified Telegram source and subject evidence.
- `agent/lib/memory-repository.ts`: scoped CRUD and immediate undo.
- `agent/lib/memory-retrieval.ts`: turn retrieval orchestration.
- `agent/lib/memory-thread-brief-repository.ts`: thread activation and context loading.
- `agent/lib/memory-thread-source-repository.ts`: bounded authorized source selection.
- `agent/lib/memory-thread-brief-generator.ts`: deterministic role-block builder; название файла
  историческое, model generation внутри отсутствует.
- `agent/lib/prompt/common-fragments.ts`: root-agent save/thread policy.
- `agent/tools/capabilities.ts`: root/subagent descriptor boundary.
- `migrations/059_main_agent_owned_memory.sql`: architecture cutover.

## 12. Проверка

Meaningful coverage:

- `memory-tool-results.test.ts`: safe tool input/result and atomic thread forwarding;
- `memory-agent-guidance.test.ts`: root-agent ownership instructions;
- `memory-thread-brief.test.ts`: deterministic source-only blocks and budgets;
- `memory-agent-write.integration.test.ts`: atomic claim/thread/provenance and rollback;
- `memory-agent-owned-migration.integration.test.ts`: retirement and persisted-data preservation;
- `memory-live-read-authorization.integration.test.ts`: live read revocation;
- `mode-tool-surface.test.ts`: no `remember` descriptor in subagent;
- `compose-runtime.test.ts`: controller-compatible no-op worker without provider path.

Production-equivalent gate:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
```

## 13. Не входит в текущий scope

- automatic document-to-memory extraction;
- OCR/media memory without an explicit root-agent decision;
- semantic automatic merge/supersede/conflict creation;
- autonomous thread discovery over old memory;
- LLM-generated summaries or briefs;
- arbitrary multi-level thread hierarchy;
- cross-family or cross-group memory sharing.
