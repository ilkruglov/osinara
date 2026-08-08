# Memory System Full

## 1. Назначение и статус

Этот документ является цельной продуктовой и архитектурной спецификацией памяти Osinara.
Он описывает:

- что уже реализовано;
- какие продуктовые правила уже утверждены;
- почему выбрана текущая архитектура;
- как R0-R7 отображаются на миграции, код и тесты;
- какие medium/future детали ещё требуют отдельного решения.

Память является application concern Osinara. Eve отвечает за историю и compaction активной
agent-сессии, но не является источником долговременной памяти приложения.

R0-R7 реализованы в application code и миграциях `049`-`054`. Единая timeline, source-aware
automatic extraction, profiles, conflicts, consolidation, memory threads и bounded briefs работают
через существующие application boundaries. Независимый review/reliability audit дополнительно закрыт
миграциями `055_memory_reliability_barriers.sql` и
`056_profile_projection_notice_delivery.sql`: retention holds, terminal gaps, durable delivery
states, exact HITL evidence, worker crash semantics и безопасная очистка snapshots.
Документ синхронизирован с release `0.11.0`.

Ниже формулировки **«реализовано»** описывают текущий контракт кода. Формулировки **«будущее»**
описывают только ещё не реализованные расширения и не должны восприниматься как доступное поведение.
Подробный реестр миграций, модулей и тестов находится в разделе 14.

---

## 2. Простая модель памяти

Система состоит из четырёх логических представлений.

| Представление | Простое объяснение | Источник истины |
| --- | --- | --- |
| Оперативная лента | Что люди и Осинара реально сказали или сделали недавно | Да, пока запись находится в retention-окне |
| Долговременные утверждения | Что Осинара должна помнить после ухода сообщения из ленты | Да |
| Профили | Краткое актуальное представление человека или другого субъекта | Нет, это выборка из утверждений |
| Нити памяти | Связанные claims и эпизоды одной долгой темы: инвестиции, спорт, ремонт | Claims и outcomes — да; brief — нет |

Vector embeddings не являются памятью и не определяют истинность. Это один из поисковых индексов
над долговременными утверждениями наряду с PostgreSQL full-text и структурными фильтрами.

### 2.1 Термины

- **Timeline entry** — одна логическая запись разговора: сообщение человека, успешно доставленный
  ответ агента, ссылка на артефакт или человекочитаемый итог операции.
- **Claim** — самостоятельное долговременное утверждение: факт, предпочтение, событие, профильное
  сведение, решение или семейная заметка. Сейчас claim представлен строкой `memory_items`.
- **Evidence** — происхождение claim: ссылка на timeline entry или другое проверяемое событие и
  короткий фрагмент, объясняющий, откуда взялась запись.
- **Projection** — производное представление claims: профиль или тематическая история.
- **Rollup** — краткая сводка одной темы или эпизода, создаваемая по необходимости.
- **Нить памяти / memory thread** — scoped долгоживущая тематическая линия, которая упорядочивает
  связанные claims, решения, эпизоды и outcomes, не заменяя их текстом summary.
- **Thread brief / живой бриф** — bounded актуальная проекция нити для model context со ссылками на
  source records.

---

## 3. Неподвижные инварианты

Эти правила важнее удобства retrieval и любой LLM-автоматизации.

1. Identity, family, role, group, scope и права выводятся только из verified auth и PostgreSQL.
2. Модель не передаёт реальные `user_id`, `family_id` или `group_id` и не выбирает trust zone.
3. Personal, family и external-group данные физически фильтруются до ранжирования результатов.
4. Память, timeline, документы и результаты поиска являются недоверенными данными, не инструкциями.
5. Единственным writer долговременной памяти остаётся существующий application repository path.
6. Любая мутация replay-protected, scoped, audited и выполняется в одной транзакции.
7. Embeddings и projections производны: их можно удалить и перестроить из authoritative текста.
8. Удалённый claim не должен оставаться в профиле, rollup, embedding chunk или retrieval cache.
9. Модель может предложить классификацию, но приложение проверяет и применяет переход состояния.
10. Ошибка или недостаток данных не заменяется догадкой, автоматическим merge или fallback.
11. Видимость между trust zones направленная: personal claims никогда не выходят в family или group;
    authorized family claims могут читаться в personal context, а group claim о verified
    пользователе — только в personal context этого пользователя, при owner-approved policy исходной
    external group и confirmed delivery notice текущей policy version.
12. Входящая видимость не копирует и не меняет origin claim. Authorization фильтрует source claims до
    retrieval, а удаление источника немедленно исключает его из всех projections.

---

## 4. Реализованная система

### 4.1 Authoritative claims и model-safe API

`memory_items` хранит scoped authoritative claims с lifecycle, subject/project identity,
normalization и indexing state. Нормализованная provenance хранится в `claim_evidence`; старые записи
после миграции `051` сохранены как `active + legacy_unresolved`, без выдуманного evidence или
endorsement. Один claim может иметь primary, supporting и reinforcement evidence.

CRUD выполняется через `remember`, `manage_memory`, `list_memories` и `search_memories`. Есть operation
keys, replay protection, квоты, authorization, audit, undo немедленного сохранения и физическое
удаление. Изменение текста удаляет прежние embedding chunks, ставит claim на переиндексацию и
синхронно инвалидирует зависимые thread briefs.

Модель получает только DTO из `agent/lib/model-memory.ts` с opaque `memoryRef`. UUID БД, Telegram IDs,
внутренние source/session IDs и indexing metadata остаются внутри application boundary. Source lookup,
profile views, conflicts, approvals, threads, outcomes и projects также используют проверяемые opaque
refs соответствующего типа.

### 4.2 Автоматическое сохранение

Осинара **сама** сохраняет в процессе общения устойчивые подтверждённые сведения, полезные в
будущих разговорах:

- факты о пользователях и семье;
- интересы и предпочтения;
- значимые события и действия;
- профильные сведения;
- результаты решений;
- сведения, которые пользователь прямо попросил запомнить.

Для автоматической записи используется `confirmationMode: automatic`. Пользователь не получает
служебное уведомление о каждом таком сохранении. `confirmationMode: explicit` используется после
прямой просьбы запомнить конкретное сведение.

Не сохраняются автоматически:

- одноразовые просьбы;
- быстро устаревающие данные без долгосрочной ценности;
- предположения и выводы с недостаточной уверенностью;
- пароли, токены, API-ключи, private keys, одноразовые коды и платёжные реквизиты.

Sensitive-запись всегда проходит identity-bound HITL approval согласно scope policy и никогда не
попадает в always-on profile. Если запись создаётся из
ссылки, изображения, видео или документа, агент сначала получает достаточный контекст и не
сохраняет догадку по неполному источнику.

Все sensitive и destructive memory actions дополнительно требуют exact consumed HITL evidence до
repository mutation: `remember` для sensitive/private-to-family записи; `manage_memory` для edit/delete;
`manage_memory_approval`; `manage_memory_conflict`; `manage_memory_thread`; и update в
`manage_profile_projection`. Evidence связывает текущие `eve_session_id`, `application_session_id`,
Telegram user, `tool_call_id`, `tool_name` и hash полного tool input. Одного approval UI state или
исторической initiator-role недостаточно.

Read-only actions и bounded `manage_memory.undo` не относятся к этому approval class: `undo` является
немедленной replay-protected отменой только что созданного claim. Все действия, которые tool contracts
классифицируют как sensitive/destructive mutation, проверяют exact evidence перед repository call.

#### Критерий долговременной ценности

Автоматически сохраняется не всё сказанное, а сведения, которые могут изменить будущий ответ или
действие Осинары после окончания текущего разговора.

Сохраняются:

- устойчивые профильные факты о человеке и семье;
- интересы, предпочтения и антипатии;
- важные ограничения, включая health/safety ограничения через sensitive approval;
- повторяющиеся правила и актуальные состояния жизни;
- принятые решения и существенные договорённости;
- значимые планы, когда решение уже принято, с известной датой или периодом;
- произошедшие значимые события и подтверждённые outcomes.

Не сохраняются как долговременные claims:

- обычные команды инструментам;
- одноразовые бытовые просьбы;
- случайное текущее настроение или желание без устойчивого значения;
- вопросы, предположения, «кажется», «может быть» и неподтверждённые догадки;
- собственные формулировки и выводы Осинары без пользовательского или проверяемого источника;
- reminders как замена schedule: память может хранить контекст плана, но уведомление принадлежит
  reminder/schedule subsystem.

Каждый независимый смысл сохраняется отдельным атомарным claim. «Люблю острую пиццу, но не ем
грибы» даёт две записи. Уточнения, отрицания, даты, период действия и степень определённости нельзя
терять при нормализации текста.

Semantic extractor выбирает один закрытый результат:

```text
save | skip | needs_approval | ambiguous
```

`ambiguous` не записывается и не превращается в догадку. Уточняющий вопрос задаётся только когда
сведение важно для текущего действия или пользователь явно просит его сохранить.

#### Сведения одного человека о другом

Полезное утверждение одного verified члена семьи о другом автоматически сохраняется в разрешённом
family scope с `evidence_kind=reported` и точным source author.

Пример:

```text
Анна: Петя больше не занимается футболом.
```

Claim хранит содержание о Пете, но источником утверждения остаётся Анна. Он не считается
подтверждённым Петей. Если Петя позже утверждает обратное, обе записи связываются конфликтом и
возвращаются вместе; приложение не выбирает победителя самостоятельно.

Автор пересказа подтверждает только факт своего сообщения, а не истинность сведений о другом
человеке. Поэтому `reported` нельзя автоматически повышать до endorsement субъекта claim.

Во внешней группе действует то же правило, но claim остаётся только в scope этой группы. Если subject
является verified участником, owner явно включил external self-projection для origin group и matching
notice подтверждён как доставленный, claim может войти в его личную входящую проекцию с обязательной
атрибуцией автора и origin group. Он не становится personal claim и не раскрывается в другие группы.

#### Source-aware automatic extraction

Ограничение прежнего `remember` path устранено. `agent/lib/memory-extraction-batch-coordinator.ts`
фиксирует точный bounded snapshot model-visible turn, а background catch-up обрабатывает retained
entries, которые не вошли ни в один turn batch. `agent/lib/memory-semantic-extractor.ts` возвращает
закрытые decisions, после чего application восстанавливает scope, автора и sources из PostgreSQL и
пишет claim только через `memoryRepository`.

Caller, который вызвал Осинару, остаётся initiator в audit, но не подменяет автора source entry.
Catch-up утверждён и включён: за проход рассматривается до 8 conversations, batch ограничен 50
entries / 12 000 символов. Turn и catch-up конкурируют через exact entry coverage и не создают
повторный диапазон. Утраченное до постановки hold историческое окно фиксируется в
`memory_extraction_gaps`, а не считается обработанным.

`memory-extraction-worker` зависит от healthy `memory-embedding` во всех трёх runtime-графах:
`compose.yaml`, `compose.test.yaml` и `compose.production.yaml`. В production он дополнительно ждёт
успешную миграцию. Поэтому extraction не стартует против ещё не готового embedding boundary.

В family-private conversation каждая user entry фильтруется по актуальному membership **до**
immutable snapshot и provider call. Entry постороннего получает terminal
`AGENT_MEMORY_EXTRACTION_FAMILY_SOURCE_DENIED`, освобождает hold и не передаётся модели. Перед записью
claim приложение повторно проверяет membership авторов primary и всех supporting sources; отзыв
membership между extraction и persistence завершает candidate ошибкой без claim.

### 4.3 Hybrid retrieval

Перед каждым model turn приложение:

1. получает текст текущего обращения;
2. строит локальный 384-мерный E5 query embedding;
3. выполняет scoped PostgreSQL `simple` full-text и русскую morphology ветки;
4. выполняет scoped pgvector search по E5 chunks;
5. объединяет ветки reciprocal-rank fusion;
6. применяет branch thresholds, exact-duplicate collapse и conflict closure;
7. отдаёт модели до 12 authorized записей как недоверенный JSON.

Multilingual E5 поддерживает смысловой поиск по русскому тексту. Миграция `050` добавляет
`russian_search_vector`; `simple` остаётся для точных имён, дат, чисел, тикеров и редких названий.
Проверенный synthetic eval зафиксирован в `memory-retrieval-eval-fixture.v1.ts`; E5 уже покрывает typo
case, поэтому отдельная retrieval trigram branch не добавлена. `pg_trgm` из миграции `053`
используется только для bounded consolidation candidate generation.

При недостаточном контексте модель может сделать до трёх разных смысловых запросов через
`search_memories`. Это не retries, а bounded context deepening.

Реализованные thresholds и ranking constants находятся в `agent/lib/memory-config.ts`. Exact
duplicates схлопываются только на чтении; persisted claims и provenance не уничтожаются. Старые
claims получают ограниченный recency decay в ranking, но автоматически не удаляются.

**Будущее:** расширять eval corpus и перекалибровывать boosts/thresholds только по измерениям; temporal
intervals и более специализированный lifecycle kinds не реализованы.

### 4.4 Единая оперативная лента

PostgreSQL timeline хранит последние **1000 logical entries** для personal, family-private и external
conversations, включая сообщения участников и подтверждённо доставленные ответы агента.

Важно различать timeline и Eve session:

- лимит 1000 относится к application timeline в PostgreSQL, а не к model context;
- новая Eve session автоматически получает до **50 последних entries** и **12 000 символов**;
- продолжение session получает только unseen delta после своего PostgreSQL cursor;
- при gap агент догружает bounded диапазон через `list_group_history`;
- все Telegram chunks одного ответа являются aliases одной logical entry;
- sequence группы монотонный, не переиспользуется после retention и может иметь пропуски;
- лимит 1000 применяется ко всему Telegram chat, а не отдельно к каждой forum topic.

Стабильная `application_conversations` identity соответствует Telegram chat. Forum topic хранится как
source partition metadata (`message_thread_id`) внутри chat-level conversation и не делит retention,
profile или trust boundary.

### 4.5 Turn, extraction и retention

Telegram updates группы сохраняются в timeline независимо от того, обращались ли в сообщении к
Осинаре. Model turn запускается только по действующей group message policy: команда, `@username`,
reply, распознанное имя или другой разрешённый trigger.

Когда turn наконец запускается:

1. Application session читает свой durable PostgreSQL cursor.
2. Для новой session берутся последние записи перед текущим сообщением.
3. Для продолжающейся session берётся unseen delta после cursor и до текущего сообщения.
4. Delta ограничивается 50 entries и 12 000 символов; при переполнении модель получает gap marker.
5. Текущая обращённая реплика передаётся отдельно от недоверенного timeline блока.
6. После достижения session boundary cursor продвигается к текущей sequence.

Только inbound boundary текущего verified timeline turn устанавливает auth attribute
`telegramTimelineSequence`. Retrieval при его наличии извлекает query из
`<current_telegram_message>`, а не из всего timeline envelope, и fail-fast отклоняет повреждённый
envelope. Устаревший legacy attribute `telegramGroupTimelineSequence` игнорируется и не может
превратить обычный/private текст в trusted timeline turn. Exact source actions отдельно используют
текущие `telegramConversationId` и `telegramTimelineEntryId`.

Каждый новый timeline entry получает `memory_extraction_retention_holds` до успешного создания exact
immutable snapshot. Обычный retention не может удалить такой entry. После snapshot commit hold
снимается, а extraction coverage живёт отдельно от conversation cursor.

Extraction, candidate resolution, consolidation, thread discovery и brief generation используют
durable leases. Expired или crash-ambiguous provider attempt становится terminal `failed`; hidden
retry запрещён. Повтор возможен только explicit bounded operator action. Terminal snapshots
очищаются отдельным recovery-safe cleanup path после завершения candidates/approvals/consolidation.

Успешно доставленные final Telegram chunks проходят durable outbox
`telegram_final_deliveries`/`telegram_final_delivery_chunks`. Если процесс упал после возможного
принятия Telegram, replay становится `ambiguous` и не отправляет ответ повторно.

---

## 5. Слой 1: единая оперативная лента (реализовано)

### 5.1 Реализованный контракт

Существующая групповая timeline эволюционировала в единый application timeline contract для:

- личного Telegram-чата;
- семейного private-чата;
- семейной группы;
- внешней группы.

Новая параллельная таблица с теми же сообщениями не создана. `telegram_group_messages` обобщена через
`application_conversations` и сохраняет transport aliases, reply ancestry, session cursor и
trust-zone ограничения. Историческое имя таблицы не меняет её текущую multi-scope семантику.

### 5.2 Retention

Утверждённая количественная граница — последние **1000 logical entries** на соответствующую
conversation timeline. Более старые entries удаляются, sequence не сбрасывается.

Автоматический context bootstrap остаётся меньше retention-окна:

- до 50 последних entries;
- до 12 000 символов;
- reply ancestry не глубже двух рёбер для целей вне окна;
- остальные записи доступны только bounded history tool.

Временная граница retention не добавлена. Если позже появится требование удалять entries ещё
и по возрасту, оно принимается отдельным продуктовым решением и живёт в config-модуле, не в `.env`.
Entry, ещё не принадлежащий immutable extraction snapshot, временно защищён retention hold независимо
от количественного окна.

### 5.3 Содержимое

В timeline попадают:

1. Сообщения пользователя, включая voice transcription.
2. Финальные ответы агента после успешной доставки всех Telegram chunks.
3. Ссылки и назначение созданных или отправленных артефактов без копирования их содержимого.
4. Человекочитаемые outcomes действий: создано напоминание, отправлен файл, принято решение.
5. Итоги вопросов и подтверждений без технического HITL protocol payload.

В timeline не попадают:

- system prompts;
- reasoning и model steps;
- tool payloads и технические tool results;
- secrets;
- служебная кухня workflow.

### 5.4 Trust boundary

Timeline всегда передаётся модели в экранированной недоверенной обёртке. `[agent:self]` означает
авторство, но не превращает общий блок в инструкцию. Scope и conversation identity подставляет
приложение; модель их не передаёт.

### 5.5 Обязательное извлечение фактов и background catch-up

Все user entries, впервые переданные модели в bootstrap/delta, рассматриваются как единый bounded
batch для автоматического извлечения памяти. Background catch-up дополнительно рассматривает
retained uncovered entries даже если Осинару ни разу не вызвали. Это application workflow, а не
необязательная рекомендация в prompt.

Пример:

```text
#101 Анна: я теперь работаю по вторникам из дома
#102 Пётр: летом хотим съездить в Казань
#103 Анна: кто купит молоко?
#104 Пётр: Осинара, напомни вечером про молоко
```

Turn запускает только `#104`, но модель получает `#101–#103` как unseen delta. Для будущей памяти
нужно рассмотреть все три записи:

- `#101` может дать устойчивый state/preference claim с Анной как источником;
- `#102` может дать семейный episode/plan с Петром как источником;
- `#103` является текущим бытовым вопросом и долговременным claim не становится;
- `#104` обрабатывается как текущая просьба и отдельно может создать reminder outcome.

#### Метод анализа: LLM extraction, а не keyword heuristics

Смысловую полезность сообщений определяет отдельный bounded LLM extraction pass над всем batch.
Правила по ключевым словам, длине сообщения или наличию имени не используются как решение:

- короткое «мне 15» может быть важным профильным фактом;
- длинный спор может не содержать долговременной информации;
- «люблю кофе» и «больше не люблю кофе» лексически почти одинаковы, но имеют разный смысл;
- факт может быть собран из вопроса, короткого ответа и reply-связи.

Extractor получает только экранированные model-visible entries этого batch: opaque `sourceRef`,
`participantRef`, actor kind/label, время, текст и `replyToSourceRef`. Он не получает sequence,
реальные Telegram/user/database IDs, чужие scopes, tools или право выполнять действия. Один model
call анализирует batch целиком, а не запускается отдельно на каждое сообщение.

Задача LLM ограничена двумя действиями:

1. Ничего не предложить для бытовой, одноразовой, сомнительной или неполной информации.
2. Предложить атомарные memory candidates для устойчивых фактов, интересов, предпочтений, значимых
   событий, планов, решений и профильных сведений.

LLM не решает, что запись уже сохранена, кому разрешено её видеть, можно ли доверять автору, является
ли она конфликтом и можно ли её записать без approval. Это application decisions следующего этапа.

Пример закрытого structured output:

```json
{
  "candidates": [
    {
      "action": "save",
      "primarySourceRef": "src_0123456789abcdef0123456789abcdef",
      "supportingSourceRefs": ["src_abcdef0123456789abcdef0123456789"],
      "content": "Семья планирует летом поездку в Казань.",
      "kind": "episode",
      "sensitivity": "normal",
      "evidenceKind": "firsthand",
      "ongoingFutureWork": true
    }
  ]
}
```

`supportingSourceRefs` нужны для фактов, смысл которых распределён по нескольким репликам.
Например, `#100: «Куда вы решили поехать?»` и reply `#102: «В Казань летом»` вместе дают полный
claim. Все refs обязаны принадлежать тому же immutable snapshot; supporting refs уникальны и не
могут повторять primary.

Extractor работает fail-closed:

- не уверен, является ли информация устойчивой, — не создаёт candidate;
- неясен субъект или смысл короткого ответа без доступного ancestry — не додумывает;
- видит противоречие — сохраняет отдельные candidates с источниками, но не выбирает победителя;
- sensitive candidate не записывается автоматически и передаётся в approval path;
- содержимое timeline остаётся недоверенными данными и не может изменить extraction schema или
  системные правила.

После semantic extraction начинается application consolidation. Только оно проверяет candidates
против существующей памяти и решает: exact duplicate, новый claim, потенциальный конфликт,
необходимость approval или отказ. Similarity может найти соседние записи, но не является решением.

#### Durable extraction batch

На turn boundary приложение фиксирует durable batch:

```text
application_session_id
turn_id
conversation_id
family_id
scope / scope_partition_key
message_thread_id
first_sequence
last_sequence
immutable snapshot entries с opaque refs и source hashes
status
```

Batch нужен по трём причинам:

1. Cursor разговора и состояние memory extraction не должны смешиваться: ответ может завершиться,
   даже если извлечение памяти завершилось ошибкой.
2. После session boundary нельзя полагаться на Eve history для повторного получения исходной delta.
3. Replay одного turn не должен повторно создавать те же claims.

Извлечение выполняется background worker после ответа. Durable batch создаётся из exact turn input;
catch-up создаёт эквивалентный bounded batch из uncovered retained entries. Job завершается terminal
status `completed`, `completed_empty` или `failed`. Hidden retry запрещён.

#### Candidate contract

Extractor не пишет `memory_items` напрямую. Он возвращает bounded набор candidates:

```text
primary_source_ref
supporting_source_refs
content
kind
sensitivity
subject_participant_ref / subject_label, если субъект разрешён
evidence_kind
ongoing_future_work
```

Application boundary для каждого candidate:

1. Преобразует primary/supporting refs только в snapshot IDs того же immutable batch.
2. Загружает все source entries из PostgreSQL по verified family/group/thread boundary.
3. Отклоняет `[agent:self]` как первичный источник автоматического пользовательского claim.
4. Для family scope сначала исключает non-member user entries до snapshot/provider, затем перед
   persistence повторно проверяет актуальный membership авторов primary и всех supporting sources.
5. Для external group сохраняет только group-scoped author identity этой группы.
6. Не принимает author, scope или реальные IDs из model output.
7. Применяет существующие content policy, sensitivity approval, quota и dedup/conflict rules.
8. Создаёт claim только через единый memory repository с deterministic candidate ID и idempotent
   operation key, включающим batch, candidate и schema version.

Текущий caller, который вызвал Осинару, записывается как инициатор model turn/mutation в audit, но
не подменяет автора исходной timeline entry.

#### Gap и полнота

Если unseen диапазон больше автоматического окна, turn extractor обрабатывает только entries, реально
включённые в batch. Background catch-up добирает retained uncovered entries bounded страницами.
Если source уже был физически утрачен до установки retention hold, приложение фиксирует terminal
`AGENT_MEMORY_EXTRACTION_TIMELINE_GAP` и не делает вид, что обработало переписку.

Одна retained entry размером больше 12 000 символов не блокирует очередь навсегда: catch-up записывает
terminal gap `AGENT_MEMORY_EXTRACTION_ENTRY_TOO_LARGE`, не копирует plaintext в diagnostics, снимает
hold и затем обрабатывает следующий bounded entry. `last_contiguous_sequence` продвигается только по
непрерывной цепочке exact coverage или explicit diagnosed gaps; конкурирующий snapshot имеет приоритет
и не может одновременно превратиться в terminal gap.

Memory extraction имеет отдельный durable cursor/range state. Продвижение conversation cursor после
ответа не должно навсегда помечать пропущенные для extraction entries как обработанные.

---

## 6. Слой 2: долговременные claims (реализовано)

### 6.1 Источник истины

Долговременный claim является самостоятельной authoritative записью. Timeline объясняет его
происхождение, но retention timeline не удаляет claim автоматически.

Claim хранит короткий `evidence_snippet` и nullable ссылку на timeline entry. После pruning timeline
ссылка становится `NULL`, а claim честно показывает, что исходная запись вышла из retention-окна.

Primary, supporting и reinforcement sources нормализованы в `claim_evidence`: одна строка на одно
evidence. Claim не дублируется при exact reinforcement, а nullable timeline FK каждой evidence row
независимо переживает pruning источника.

Provenance metadata, необходимая для ответа «откуда это известно», живёт вместе с claim и не исчезает
при обычном timeline retention:

- origin conversation и snapshot его человекочитаемого названия;
- verified source author и snapshot отображаемого имени;
- точное `observed_at`;
- origin timeline sequence и Telegram message/thread reference, если они доступны;
- bounded `evidence_snippet`;
- nullable ссылка на полную timeline entry.

Memory retrieval возвращает opaque `memoryRef` и краткую provenance summary. По запросу пользователя
«откуда это известно» агент вызывает scoped source lookup с этим ref. Application повторно проверяет
personal authorization и возвращает название чата, автора, дату, snippet и доступную ссылку на
сообщение. Реальные database/Telegram IDs модели не выдаются.

External source lookup использует тот же общий
`agent/lib/external-profile-projection-predicate.ts`, что retrieval. Он fail-closed проверяет group
scope, `profile_eligible`, normal sensitivity, evidenced provenance без `inferred`, subject binding к
текущему пользователю, актуальный family membership, включённую policy и `presented` notice текущей
policy version. Opaque `memoryRef` сам по себе не является правом доступа.

Если полная timeline entry уже удалена retention, source lookup не выдумывает цитату: он возвращает
сохранённые origin metadata и evidence snippet с явной отметкой, что полное исходное сообщение больше
недоступно. Удаление origin claim удаляет и возможность найти его через personal projection.

Отдельный вечный immutable evidence store не создаётся, потому что он:

- дублировал бы ingress/timeline;
- конфликтовал бы с правом удаления;
- всё равно не позволял бы полностью перестроить память после pruning старой ленты.

### 6.2 Реализованная схема claims

`memory_items` эволюционировала на месте. Реализованы:

```text
subject_family_id
subject_user_id
subject_participant_id
subject_label
origin_conversation_id
save_approved
endorsed_by_user_id
endorsed_at
claim_status
provenance_state
superseded_by
duplicate_of
reinforcement_count
last_reinforced_at
content_normalized
profile_eligible
memory_project_id
```

Поля конкретного источника (`evidence_kind`, author, timeline sequence/message/thread reference,
snippet и origin label snapshot) находятся в `claim_evidence`, а не предполагают, что у claim всегда
ровно один источник. `memory_items` хранит subject/project, scope, canonical content и lifecycle;
primary evidence задаётся отдельной row с уникальным role.

**Будущее:** `valid_from`/`valid_to` не реализованы и добавляются только при доказанной потребности в
temporal historical intervals.

### 6.3 Разделённые оси подтверждения

Исторический `confirmation` смешивал несколько разных вопросов:

- попросил ли пользователь сохранить запись;
- было ли разрешено хранение sensitive content;
- подтверждал ли человек истинность содержания;
- является ли текст пересказом;
- считает ли модель собственный вывод уверенным.

Реализованная модель разделяет эти оси:

| Поле | Значение |
| --- | --- |
| `evidence_kind` | `firsthand`, `reported`, `inferred` |
| `attributed_to_user_id` | Кто является источником утверждения, если это проверенно известно |
| `save_approved` | Проходило ли сохранение через application approval |
| `endorsed_by_user_id` | Кто явно подтвердил содержание |
| `endorsed_at` | Когда содержание было подтверждено |

Model self-confidence не становится метаданными истинности. Миграция `051` сохранила старые rows как
`legacy_unresolved`, с `endorsed_by_user_id = NULL`, `endorsed_at = NULL` и без invented evidence.

### 6.4 Субъект утверждения

Модель не получает и не передаёт реальные user IDs. Для personal/family turn приложение выдаёт
roster текущих verified участников с непрозрачными refs:

```json
[
  {"ref":"subj_0123456789abcdef0123456789abcdef","name":"Анна"},
  {"ref":"subj_abcdef0123456789abcdef0123456789","name":"Пётр"}
]
```

`remember` принимает только optional `subjectRef` или свободный `subjectLabel`:

- `subjectRef` проверяется приложением и преобразуется в `subject_user_id`;
- ref валиден только в разрешённой семье и session/scope;
- невалидный ref вызывает fail-fast input error;
- неразрешённые «мама», «Аня из школы», «кот Барсик» остаются text label;
- отсутствие субъекта является нормальным состоянием;
- external group не получает family roster.

Ошибочно не привязать claim безопаснее, чем склеить сведения разных людей.

`origin_conversation_id` является application-owned ссылкой на verified conversation boundary. Она
нужна для chat-local profiles и никогда не выбирается моделью. Один `subject_user_id` может иметь
разные независимые профили в разных чатах без копирования claims между ними.

После выхода участника из external group его historical subject ref может использоваться только
внутри той же origin group. Новый claim связывается с бывшим участником лишь при проверяемом Telegram
identity signal или однозначной application-owned связи; простой текст имени или изменяемый username
не является достаточным доказательством.

---

## 7. Профили (реализовано)

Профиль не является новой копией памяти. `profile_subjects` хранит только verified chat-local
identity, а `profile_views` — immutable bounded read snapshot; authoritative факты остаются claims.
Логический ключ
профиля:

```text
origin conversation + verified subject
```

Один Telegram-пользователь в двух внешних группах имеет два независимых профиля. Claim из одной
группы не наполняет профиль другой группы. `profile_subjects` создаётся после verified observation
участника; subject без eligible claims не включается в profile view или model context.

Claims о неразрешённом персонаже могут хранить `subject_label`, но не связываются с participant
profile до проверяемого identity resolution. Совпадение имени недостаточно.

Always-on profile block содержит небольшой набор базовых сведений, благодаря которым
агент стабильно знает релевантных текущему разговору участников без точного совпадения запроса с
embedding. В групповом turn нельзя автоматически инъецировать профили всех известных участников.
Context assembler выбирает bounded набор:

1. автора текущего сообщения;
2. участника, на сообщение которого отвечают;
3. явно упомянутых verified участников;
4. subjects релевантных retrieval results.

Остальные chat-local profiles доступны через scoped retrieval.

Обязательный контракт:

- scope-фильтрация выполняется в SQL до формирования блока;
- личный чат видит свои personal claims, разрешённый family scope и external self-claims только из
  owner-approved групп с delivered notice текущей policy version;
- семейная группа не видит personal claims;
- external group не получает family profile;
- external group не получает personal claims или profiles из других external groups;
- family и external profiles остаются chat-local даже для одного `subject_user_id`;
- только active claims;
- эпизоды не входят в always-on;
- жёсткий лимит записей и символов;
- детерминированный стабильный порядок;
- содержимое остаётся недоверенными данными;
- пользователь может повторно прочитать ровно тот же immutable snapshot через opaque
  `profileViewRef`;
- edit/delete немедленно меняет следующий profile block.

### 7.1 Направленная видимость

Видимость задаётся application policy, а не переносом данных:

| Origin claim | Personal verified subject | Family context | Та же external group | Другая external group |
| --- | --- | --- | --- | --- |
| Personal | да | нет | нет | нет |
| Family | да для active member | да | нет | нет |
| External claim о subject | да только после owner opt-in и confirmed notice delivery | нет | да | нет |
| External claim о другом участнике | нет | нет | да | нет |

Personal context является более приватной входящей точкой, но не глобальным профилем. Его effective
profile собирается как read projection:

```text
personal claims пользователя
+ authorized family claims
+ claims о том же verified пользователе из owner-approved external groups после delivered notice
```

External часть по умолчанию **отключена** для каждой группы. Только актуальный owner может явно
включить её через opaque `groupRef`; изменение replay-protected, exact-HITL-protected, audited и
создаёт versioned group notice. Миграция `056_profile_projection_notice_delivery.sql` делает policy
fail-closed: до `delivery_status = presented` для **текущей** `policy_version` external claim не входит
ни в profile, ни в retrieval, ни в source lookup. Notice переходит `pending → started → presented`
только после успешного `sendMessage`; send failure не подтверждает доставку, а stale `started`
становится terminal `ambiguous`, чтобы исключить дублирующую отправку. Более новое owner decision
terminally supersede-ит старый unseen notice.

После подтверждённой доставки включаются `firsthand` и `reported` claims, но не `inferred`.
`reported` всегда рендерится с source author и origin group и не считается endorsement пользователя.
В personal projection нельзя переносить весь external transcript, claims о других участниках,
анонимные сообщения или связь, доказанную только совпадением имени.

Origin claim остаётся в своей trust zone. Personal projection хранит ссылку, а не копию: она не
может изменить origin scope, автоматически переписать personal claim или распространить результат
обратно в family/external context. Удаление origin claim немедленно удаляет его из effective profile.

Выход verified пользователя из external group не удаляет ранее созданные claims и не закрывает ему
личную read projection. Новые `reported` claims о нём, созданные в origin group после выхода, также
могут входить в его personal projection, если subject identity доказана application logic. Personal
projection получает только атомарный claim и provenance, а не новый transcript или память других
участников. Group-local profile сохраняется: если тот же Telegram `user_id` вернётся, продолжает
использоваться тот же профиль, а не создаётся новый по username или отображаемому имени.

Username, nickname и display name являются только presentation metadata и не используются как ключ
identity. Последняя активность определяется по verified timeline entries с Telegram `from.id`.
Отсутствие verified сообщений в течение 60 дней делает subject dormant только для automatic profile
selection. Это недеструктивно: claims, history и scoped retrieval сохраняются; новый verified message
снимает dormancy. Значение задано `PROFILE_SELECTION_DORMANCY_MILLISECONDS`.

### 7.2 Межскоуповая актуальность в personal projection

Claims разных origin scopes не merge-ятся и не supersede-ят друг друга в authoritative storage.
Personal context может сгруппировать доступные сведения об одном verified subject на чтении:

- совпадающие claims отображаются компактно с сохранением всех origins;
- более новый `firsthand` claim того же пользователя может отображаться как его текущее изменяемое
  состояние, но не мутирует старую запись в другом scope;
- разные источники или стабильные несовпадающие факты возвращаются вместе как read-only discrepancy;
- модель не скрывает origin и не выбирает победителя между разными авторами.

Sensitive claims исключены из always-on всегда. Per-claim override не предусмотрен: они сохраняются
только после HITL и доступны через явный scoped retrieval. Это утверждённый fail-closed default, а не
временный запрет до следующего решения.

Profile view строится обычным bounded `SELECT` и сохраняет воспроизводимый opaque snapshot ref.
Отдельная materialized projection рассматривается только после измеренного performance bottleneck.

---

## 8. Дубликаты и consolidation (реализовано)

### 8.1 Безопасная автоматизация

Автоматически одинаковыми считаются только записи, совпавшие после безопасной нормализации:

- Unicode NFKC;
- lowercase;
- схлопывание пробелов;
- нейтральная нормализация пунктуации.

Даже exact duplicate не обязан физически удаляться: кластер может отображаться одной записью на
чтении, сохраняя provenance исходных утверждений.

### 8.2 Similarity не является решением

Cosine и trigram similarity используются только для поиска кандидатов. Они не могут автоматически
merge/delete claims: отрицания, разные числа и даты часто имеют очень близкие embeddings.

Bounded relation classifier получает новый claim и ограниченный набор найденных в том же trust zone
кандидатов. Он предлагает для каждой действительно связанной пары одно из:

```text
new | duplicate | refinement | temporal_update | correction | conflict
```

Приложение применяет только безопасную связь:

- `new` — независимый claim без связи;
- `duplicate` — `duplicate_of`, без потери отдельных evidence;
- `refinement` — более точная версия того же смысла;
- `temporal_update` — изменяемый факт получил новое актуальное значение;
- `correction` — тот же verified speaker явно исправил свою прежнюю запись;
- `conflict` — взаимоисключающие версии остаются доступны вместе.

Classifier не пишет в БД, не меняет scope и не получает произвольные database IDs. Application
repository проверяет opaque candidate refs, subject, property, provenance, mutability class,
отрицание, числа, даты и допустимый lifecycle transition. Разные числовые или датные значения
запрещают автоматический `duplicate`. HITL используется для существенных неразрешимых
противоречий, а не для каждого похожего текста.

---

## 9. Конфликты и актуальность (реализовано)

### 9.1 Конфликт является отношением

Две независимо подтверждённые записи могут противоречить друг другу. Confirmation и conflict —
разные оси. Поэтому `disputed` не хранится как status одной строки.

Таблица `claim_conflicts` связывает две записи в одном family/scope trust zone:

```text
claim_a
claim_b
family_id
scope
owner_user_id для personal
detected_at
resolution
resolved_at
```

DB constraints гарантируют форму и одинаковую tenant boundary там, где это выражается
декларативно. Смысловой конфликт проверяет application repository; DB triggers используются только
для integrity/invalidation, а не для скрытого semantic решения.

Конфликт разрешается по opaque `conflictRef`. Repository под lock повторно проверяет актуальную роль
и trust zone; `choose` переводит проигравшую версию в `retracted`, но не удаляет её. `keep_both` и
`keep_unresolved` также replay-protected и audited.

### 9.2 Retrieval closure

Конфликт нельзя решать score boost. После обычного top-N retrieval приложение вторым проходом
обязательно догружает неразрешённых conflict partners выбранной записи независимо от их score.
Обе стороны проходят полный актуальный authorization predicate. Если хотя бы один partner больше не
доступен, применяется правило both-or-none: весь conflict group и уже выбранная видимая сторона
исключаются из результатов, без чтения или утечки content/metadata недоступного partner.

Модель получает один сгруппированный блок:

```text
Конфликт:
- Анна подтвердила X, дата и источник.
- Пётр подтвердил Y, дата и источник.
Не выбирать версию самостоятельно.
```

Конфликт либо показывается пользователю, либо разрешается через отдельный HITL flow. Personal claim
одного владельца никогда не связывается конфликтом с personal claim другого владельца. Конфликты
между разными scopes не создаются.

### 9.3 Status

Минимальный lifecycle claim:

- `active` — участвует в обычном retrieval;
- `superseded` — заменён разрешённым уточнением, temporal update или correction;
- `retracted` — содержание отозвано.

Произвольный automatic supersede по одному лишь semantic similarity запрещён. Он допустим только
после closed relation classification и детерминированных application guards:

- прямые claims принадлежат тому же verified subject и trust zone;
- relation связывает одно и то же свойство, а не просто похожие фразы;
- `temporal_update` разрешён только для явно изменяемого класса фактов;
- `correction` требует явного языка исправления от того же verified speaker;
- claim другого автора о субъекте не supersede-ится прямым отрицанием субъекта, а образует conflict;
- старый claim не удаляется и остаётся доступным как историческая версия.

Например, более позднее прямое «я больше не люблю кофе» автоматически становится актуальной версией
предпочтения того же человека и supersede-ит его прежнее «я люблю кофе». Более поздняя дата сама по
себе не исправляет стабильные профильные данные вроде даты рождения: без явного «исправляю» это
конфликт.

### 9.4 Правила актуальности

- Exact duplicate добавляет evidence, а не вторую независимую карточку в model context.
- Refinement становится текущей более точной формулировкой; прежний claim сохраняет provenance.
- Явное изменение состояния, плана или предпочтения создаёт новую active версию и переводит прежнюю
  в `superseded`.
- Явное исправление собственного claim заменяет прежнюю версию даже для стабильного свойства.
- Противоречие разных источников создаёт conflict и не выбирает победителя автоматически.
- `reported` claim одного члена семьи о другом не считается исправленным или подтверждённым прямой
  репликой субъекта; несовпадение возвращается пользователю как конфликт источников.
- Claims из разных scopes никогда не получают persisted merge, supersede или conflict relation.
  Разрешённая personal projection может только совместно отобразить их как read-only discrepancy с
  сохранением origins.

Explicit `manage_memory.edit` не переписывает старую строку in place. После exact HITL он требует
текущие `telegramConversationId` и `telegramTimelineEntryId`, создаёт новый `evidenced` active claim с
primary `claim_evidence`, связывает версии `correction`, а старую переводит в `superseded`. Subject,
project и trust zone сохраняются; evidence kind становится `firsthand` только когда verified автор
исправления совпадает с subject, иначе остаётся `reported`.

Если старый claim входил в memory threads, его role/order переносится на новый claim **до** retirement
старого source. Затем обычная source invalidation удаляет inactive entry/brief, retract-ит зависящий
confirmed completion outcome и реактивирует completed thread без потери исправленной thread
membership. Контракт проверяется `memory-completion-source-invalidation.integration.test.ts`.

Temporal fields `valid_from`/`valid_to` добавляются позже для доказанных исторических сценариев.
Они не нужны для запуска профилей и конфликтов. Если дата не названа явно, модель не придумывает
начало периода; `observed_at` остаётся временем, когда утверждение было получено.

---

## 10. Поиск и сборка model context

Реализованный retrieval pipeline:

```text
verified authorization filter
→ simple exact-token candidates
→ Russian morphology candidates
→ vector candidates
→ calibrated fusion and relevance threshold
→ exact-duplicate collapse on read
→ conflict closure
→ bounded context assembly
```

### 10.1 Retrieval eval и calibration

Colocated versioned eval fixture без реальных семейных данных включает:

- русские словоформы;
- русско-английский текст;
- парафразы без лексического пересечения;
- запросы по людям и событиям;
- опечатки;
- exact duplicate pollution;
- запросы без релевантной памяти.

Зафиксированные acceptance metrics:

- positive Recall@5;
- доля пустых ответов на нерелевантные запросы;
- duplicate pollution в top 5;
- simple/Russian/semantic branch attribution;
- отдельный typo-recovered signal.

Русская morphology branch и thresholds добавлены после baseline и проверяются тем же eval. Retrieval
trigram не понадобился; typo case прошёл через E5. Новые boosts и branches не подбираются на глаз.
Conflict closure проверяется отдельными repository tests. **Будущее:** nDCG и p95 latency можно
добавить в eval при расширении corpus или изменении ranking architecture.

### 10.2 Context assembly

В model context собираются разные блоки с отдельными бюджетами:

1. Always-on профиль — небольшой стабильный набор базовых claims.
2. Query-driven relevant claims — текущий hybrid retrieval.
3. Conflict partners — обязательное расширение найденных claims.
4. Timeline bootstrap/delta — недавний разговор.
5. Thread brief и релевантные эпизоды — при активации соответствующей нити.

Ни один слой не имеет права вытеснить обязательное предупреждение о конфликте или скрыть отсутствие
данных.

---

## 11. Нити памяти (реализовано)

Календарные weekly summaries из первоначальной схемы не становятся обязательным слоем.

Причины:

- одна неделя смешивает несвязанные темы;
- embedding большого summary размывает retrieval;
- небольшая неделя порождает бессодержательный cron-вызов;
- удаление одного claim требует инвалидировать содержащую его сводку;
- summary может накапливать ошибки повторной компрессии.

Вместо weekly cron используется **нить памяти** (`memory_thread`) и её bounded **живой бриф**
(`thread_brief`) по требованию:

- «инвестиции Сергея»;
- «тренировки Сергея»;
- «ремонт квартиры»;
- «поездка в Казань»;
- «лечение кота».

### 11.1 Нить не является вторым хранилищем истины

Conversation timeline и memory thread — разные сущности:

- timeline хранит bounded сырой ход разговора;
- thread переживает timeline retention как ordered набор ссылок на долговременные claims, эпизоды и
  подтверждённые outcomes;
- goal, constraint, preference, method, decision, outcome и lesson остаются отдельными атомарными
  memory records со своим provenance;
- thread не имеет права добавлять unsupported текст, которого нет в связанных records.

Обязательная цепочка доказательств:

```text
memory thread
→ thread entry
→ atomic claim / episode / confirmed tool outcome
→ timeline entry или проверяемое application event
```

Один эпизод может ссылаться на несколько claims и source events. Например, инвестиционная закупка
связывает действующий risk profile, выбранную методику, решение, подтверждённую операцию и следующий
шаг. Сохраняется краткое human-readable rationale и перечисление использованных данных, но не скрытая
chain-of-thought модели.

### 11.2 Persisted форма

Нить имеет только стабильную scoped identity и связи:

```text
memory_threads
- id
- scope / trust zone
- verified subject или subject label
- title
- optional parent_thread_id
- status
- completed_at
- completion_episode_id
- created_at / updated_at

memory_thread_entries
- thread_id
- source memory/outcome ref
- role: goal | constraint | method | decision | episode | outcome | lesson | open_loop
- occurred_at
- stable order
```

Связь может предложить LLM, но application проверяет существование source record, authorization,
одинаковую trust zone и idempotency. Это специализированная тематическая группировка, а не generic
entity graph.

Один authoritative claim или outcome может иметь несколько `memory_thread_entries` и входить в
несколько нитей одного verified subject и scope. Например, ограничение по колену может относиться к
нитям «Бег» и «Силовые тренировки». Текст claim, evidence и lifecycle при этом не копируются.

Multi-attach ограничен application guards:

- каждая связь должна иметь самостоятельную semantic relevance к нити;
- subject и trust zone source record совпадают с нитью;
- одинаковая пара thread/source idempotent;
- изменение, supersede, retraction или удаление source record инвалидирует briefs всех связанных
  нитей;
- при одновременной активации нескольких нитей context assembler рендерит общий claim один раз и
  перечисляет связанные threads, не расходуя бюджет на дубликаты.

### 11.3 Granularity: broad first

По умолчанию создаётся широкая долговременная нить: «Тренировки», «Инвестиции», «Ремонт». Узкая тема
не получает отдельную нить только потому, что образовала semantic cluster.

Bounded classifier может выбрать `create_subthread`, когда подтема одновременно:

- повторяется в нескольких source-backed эпизодах;
- имеет собственную долгосрочную цель или отдельную методику;
- имеет свои решения, outcomes или open loops;
- ухудшает релевантность широкого brief либо требует самостоятельного контекста.

Примеры:

```text
Тренировки
└── Подготовка к марафону 2027

Инвестиции
└── Портфель для первоначального взноса
```

Выделение subthread недеструктивно. Source records остаются authoritative и могут одновременно
ссылаться из широкой и узкой нити. Широкий brief сохраняет обзор, а подробности подтемы загружаются
через её brief.

Поддерживается максимум один уровень: root thread и optional focused subthread. Более глубокая
иерархия, автоматическое дерево микротем и generic graph запрещены. Ошибочное выделение не удаляет
claims; subthread можно закрыть, сохранив source links в широкой нити.

Thread не создаёт persisted cross-scope links. В personal context его read projection может временно
учесть разрешённые family или external self-claims по ранее согласованной inward-only policy, сохраняя
их origins.

### 11.4 Живой бриф

Thread brief является навигационной проекцией, а не evidence. Он генерируется durable terminal-attempt
job только при активации и содержит bounded текущий срез:

- профиль и ограничения, относящиеся к теме;
- действующую методику;
- последние значимые решения и эпизоды;
- подтверждённые outcomes и уроки;
- открытые вопросы и следующий шаг.

Первая production-конфигурация использует named constants в application config, не `.env`:

```text
THREAD_CONTEXT_MAX_THREADS = 2
THREAD_CONTEXT_MAX_CHARACTERS = 16_000
THREAD_BRIEF_MAX_CHARACTERS = 6_000
THREAD_BRIEF_MAX_ITEMS = 20
THREAD_CONTEXT_EPISODES_PER_THREAD = 3
THREAD_EPISODE_MAX_CHARACTERS = 2_000
```

Общий лимит 16 000 символов включает briefs и episode representations всех активированных нитей и
имеет приоритет над суммой частных максимумов. Records не обрезаются посередине: context assembler
выбирает целые source-backed items в порядке:

1. актуальные ограничения и unresolved conflicts;
2. активные цели и open loops;
3. действующая методика;
4. последние решения и подтверждённые outcomes;
5. применимые lessons;
6. релевантные и недавние episodes.

Если релевантны больше двух нитей, application сначала выбирает thread, явно связанный с текущим
skill/tool context, затем явно названную тему, затем нити с наибольшим количеством authorized
retrieval hits. Одинаковый claim учитывается в бюджете один раз.

Completed subthread по умолчанию представлен только completion episode. Полный completed brief
занимает слот и бюджет лишь при явном или семантически сильном историческом запросе.

Каждое содержательное положение brief покрывается source record refs. Brief можно кэшировать после
реальной активации нити. Cache хранит source IDs и generation version; изменение, supersede,
retraction или удаление source record синхронно инвалидирует его в той же mutation boundary.

Нить активируется явным skill/tool context или релевантным запросом. В model context входят bounded
brief и только несколько релевантных эпизодов, а не вся история нити.

Если initial context недостаточен, scoped thread-history lookup возвращает следующую bounded страницу
до 20 entries / 12 000 символов с source refs. Это явное context deepening, а не автоматическая
загрузка всей нити.

Для инвестиционной нити актуальные позиции, цены и остатки всегда загружаются из T-Invest API.
Память хранит профиль, принятую методику, решения, rationale и подтверждённые исторические outcomes,
но не выдаёт старый snapshot портфеля за текущее состояние. Для спортивной нити health-related
claims сохраняют действующую sensitive approval policy.

### 11.5 Автоматическое создание нити

Нить создаётся без confirmation, когда есть доказанная долгоживущая деятельность: ожидаются новые
этапы, повторные решения, действия, outcomes или дальнейшая совместная работа. Одноразовое обсуждение
не создаёт пустую нить.

Есть два discovery path:

1. **Online semantic detection.** Во время содержательного разговора LLM предлагает thread candidate,
   если видит продолжительную систематическую деятельность и намерение вернуться к ней.
2. **Backend recovery detection.** После появления новых indexed claims приложение ищет внутри одной
   trust zone и одного verified subject повторяющийся узкий тематический кластер, чтобы обнаружить
   нить, которую online path ранее пропустил.

Embeddings, количество совпадений и частота разговоров только отбирают candidate cluster. Они не
доказывают, что claims образуют одну деятельность. Bounded LLM classifier получает opaque refs и
закрыто выбирает:

```text
attach_existing | create_new | create_subthread | unrelated | ambiguous
```

`ambiguous` не создаёт нить и не требует вопроса пользователю: кандидат ждёт новых evidence. Один
source record может получить bounded `attach_existing` к нескольким релевантным нитям. Модель не
передаёт scope, subject ID или реальные database IDs.

Discovery использует два разных gate, потому что один числовой порог не подходит одновременно для
ежедневных тренировок и ежемесячных инвестиционных решений.

**Immediate semantic gate** разрешает создать нить после одного содержательного разговора, если:

- есть хотя бы один source-backed durable claim;
- пользователь явно описывает продолжающуюся деятельность, цель или совместную работу в будущем;
- ожидаются следующие действия, решения или outcomes, а не только справочный ответ;
- classifier может сформулировать устойчивую тему и initial thread role.

Сам по себе запуск тематического skill не создаёт нить: просмотр одной котировки или разовый вопрос
не доказывает продолжительную деятельность.

**Backend recovery gate** запускает classifier при всех условиях:

```text
THREAD_DISCOVERY_MIN_CLAIMS = 3
THREAD_DISCOVERY_MIN_SOURCE_BATCHES = 2
THREAD_DISCOVERY_LOOKBACK_DAYS = 90
```

Claims должны принадлежать одному verified subject и trust zone, происходить минимум из двух
непересекающихся durable extraction batches и образовывать узкий hybrid-retrieval cluster. Девяносто
дней позволяют обнаруживать редкие инвестиционные или медицинские процессы; две независимые source
batches не дают одной насыщенной беседе ошибочно выглядеть повторяющейся практикой.

Эти значения являются production defaults для candidate generation, а не порогом истинности.
Semantic classifier всё равно обязан доказать систематическую тему и выбрать `create_new` или
`attach_existing`. Offline eval измеряет missed threads, false creations, duplicate threads и время
до обнаружения; изменение constants допускается только по результатам этого eval.

Recovery scan встроен в общий memory worker loop. Он читает только ещё не рассмотренные durable
claims через `memory_thread_discovery_claim_coverage` и восстанавливается после остановки worker, не
анализируя всю память повторно.

Оба discovery path вызывают один application coordinator. Он:

- повторно проверяет scope, subject, sources и content policy;
- сначала ищет существующие нити того же subject/trust zone;
- не допускает объединения похожих тем разных людей или чатов;
- использует idempotent candidate key и transaction lock, поэтому online и backend path не создают
  две нити одновременно;
- создаёт thread и initial entries через один repository boundary;
- не создаёт persisted cross-scope links.

После успешного создания пользователь получает одно короткое уведомление без запроса подтверждения:

```text
Начата новая нить памяти: «Тренировки». Буду связывать с ней цели, решения и результаты, чтобы
сохранять контекст между обсуждениями.
```

Уведомление привязано к committed thread ID и доставляется не более одного раза. Repository сначала
переводит notice в `started`, Telegram boundary вызывает `sendMessage`, и только после подтверждённого
resolve помечает его `presented`; ошибка становится `failed` или `ambiguous`, а не ложным delivered
state. Если нить создана background path вне активного turn, durable pending notice показывается при
следующем разрешённом взаимодействии, а не отправляется неожиданным ночным сообщением.

### 11.6 Автоматическая активация существующей нити

Перед сборкой model context приложение проверяет нити после обычного authorized retrieval:

1. Явный skill/tool context предоставляет application-owned тематический hint без выбора scope
   моделью.
2. Retrieval возвращает claims и их thread memberships.
3. Backend группирует найденные memberships и выбирает bounded релевантные threads.
4. Context assembler добавляет живой brief и несколько релевантных episodes каждой выбранной нити.
5. Новые claims после turn предлагаются для attach к уже активной нити через тот же coordinator.

Поэтому запрос о тренировке может поднять нить через найденную цель или прошлый эпизод, даже если
пользователь не назвал thread явно. Совпадение по одному embedding не активирует большой brief без
пороговой релевантности и subject/scope guards.

### 11.7 Завершение нити

Focused subthread получает `completed` только по проверяемому событию: явному сообщению пользователя,
подтверждённому tool outcome или достижению формально заданной цели. Inactivity не означает
завершение и не позволяет модели выдумать результат.

При завершении создаётся source-backed **completion episode**:

```text
Нить: Подготовка к марафону 2027
Период: подтверждённые даты начала и завершения
Цель: исходный goal claim
Результат: подтверждённый outcome
Ключевые решения: source decision refs
Что сработало / не сработало: confirmed или явно marked inferred lessons
```

Completion episode является компактной долговременной навигационной записью, но не заменяет и не
удаляет нить. Он ссылается на исходные goals, methods, decisions, episodes, outcomes и lessons. Если
какой-либо source изменён или удалён, completion representation инвалидируется и перестраивается без
unsupported утверждения.

Широкая parent thread получает ссылку на completion episode и может показывать одну краткую строку:

```text
В 2027 году Сергей завершил подготовку к марафону; результат и ретроспектива доступны в завершённой
нити «Подготовка к марафону 2027».
```

Completed subthread не загружается автоматически в каждый разговор по широкой теме. Он остаётся
доступным через semantic retrieval, source lookup и явный запрос об истории. Новая самостоятельная
цель обычно создаёт новый focused subthread и может использовать прошлый completion episode как
evidence; старую завершённую нить не переоткрывают молча.

История темы строится как ordered выборка claims и эпизодов. Отдельный graph traversal и generic
entity graph для этого не нужны.

---

## 12. Удаление, retention и забывание

Нужно различать две операции:

- **удалить timeline entry** — убрать конкретную реплику из оперативной истории;
- **забыть claim** — убрать долговременное утверждение и все его производные представления.

Они не должны неявно каскадировать друг в друга:

- обычный retention timeline не удаляет долговременный claim;
- удаление claim удаляет embedding chunks и синхронно инвалидирует profile/rollup caches;
- nullable source link позволяет claim пережить pruning timeline;
- пользовательская команда на полное удаление конкретного сведения должна работать на уровне claim,
  а не только скрывать его из retrieval.

Автоматический decay не удаляет устойчивые факты. В будущем допустимо снижать retrieval rank старых
неподтверждённых записей. Деструктивное забывание выполняется только по явному lifecycle rule или
пользовательской команде, а не по низкой vector similarity.

Реализованная cleanup semantics удаляет plaintext extraction snapshot/candidate только после terminal
resolution и отсутствия активных approval/consolidation jobs. Hashes, range diagnostics и source
coordinates остаются для аудита. Удаление/retention source очищает nullable live links и не выдаёт
отсутствующий provenance за доступный.

**Будущее:** единая user-requested erasure semantics для сырых `telegram_ingress_updates`,
attachments, уже созданных exports, backups и допустимого audit metadata ещё не реализована. До неё
нельзя обещать удаление всех физических копий одной командой.

---

## 13. Фоновые процессы (реализовано)

Количество самостоятельных workers минимизируется.

Durable `memory_embedding_jobs`, extraction, candidate resolution, consolidation, thread discovery и
thread brief jobs имеют отдельные таблицы и общий application pattern: lease, provider-start marker,
terminal diagnostics и explicit bounded requeue там, где повтор разрешён.

Реализованный порядок автоматизации:

1. Turn boundary и background catch-up создают exact durable extraction batches.
2. Один bounded LLM call на batch создаёт candidates, но не пишет claims.
3. Candidate проходит content policy, sensitive approval, authorization, quota и consolidation.
4. Claim пишет единый `memoryRepository`; exact reinforcement добавляет evidence.
5. Thread discovery рассматривает новый evidenced claim и recovery coverage.
6. Retrieval/profile/thread projections читают только authorized active sources.
7. Hidden retries запрещены; expired/ambiguous attempt становится terminal failure.
8. Worker при SIGTERM перестаёт брать новую работу, завершает активный durable step и закрывает БД.
9. Recovery cleanup стирает plaintext resolved snapshots, включая узкое crash-окно после commit.

Недельный summarizer, отдельный decay worker, expiry worker и постоянный projection rebuilder заранее
не создаются. Profile является запросом, а rollup строится on demand.

---

## 14. Реестр реализации R0-R7

Все этапы R0-R7 реализованы. Этот раздел является краткой картой от продуктового результата к
persisted contract, application code и регрессионным тестам.

### R0. Safety and model contract — реализовано

- **Миграция:** `migrations/049_opaque_memory_refs.sql`.
- **Код:** `agent/lib/model-memory.ts`, `agent/lib/memory-repository.ts`,
  `agent/lib/memory-source-repository.ts`, `agent/lib/tools/manage_memory.ts`,
  `agent/lib/tools/get_memory_source.ts`.
- **Поведение:** model-safe DTO и `mem_*` refs; реальные database/Telegram IDs не пересекают model
  boundary; destructive similarity dedup удалён из guidance.
- **Тесты:** `agent/lib/memory-opaque-ref-migration.integration.test.ts`,
  `agent/lib/model-memory.test.ts`, `agent/lib/memory-tool-results.test.ts`,
  `agent/lib/memory-untrusted-context.test.ts`.

### R1. Retrieval quality — реализовано

- **Миграция:** `migrations/050_russian_memory_retrieval.sql`.
- **Код:** `agent/lib/memory-retrieval-repository.ts`,
  `agent/lib/memory-retrieval-ranking.ts`, `agent/lib/memory-config.ts`,
  `agent/lib/memory-retrieval-eval-fixture.v1.ts`.
- **Поведение:** `simple` + Russian morphology + pinned multilingual E5, calibrated branch gates,
  abstention, read-time exact duplicate collapse и bounded recency decay. Retrieval trigram отклонён
  после eval; trigram index используется позднее только для consolidation candidates.
- **Тесты:** `agent/lib/memory-retrieval-migration.integration.test.ts`,
  `agent/lib/memory-retrieval-eval.integration.test.ts`,
  `agent/lib/memory-retrieval-ranking.test.ts`,
  `agent/lib/memory-retrieval-repository.integration.test.ts`.

### R2a. Provenance and extraction foundation — реализовано

- **Миграция:** `migrations/051_r2a_provenance_extraction_foundation.sql`.
- **Код:** `agent/lib/conversation-repository.ts`, `agent/lib/memory-extraction-contract.ts`,
  `agent/lib/memory-extraction-repository.ts`, `agent/lib/memory-semantic-extractor.ts`,
  `agent/lib/claim-evidence-writer.ts`, `agent/lib/memory-source-repository.ts`.
- **Поведение:** stable chat-level conversation identity; group-local participants; exact snapshots;
  deterministic versioned candidates; normalized primary/supporting/reinforcement evidence; terminal
  job states. Legacy rows остаются `legacy_unresolved` и non-endorsed.
- **Тесты:** `agent/lib/r2a-provenance-migration.integration.test.ts`,
  `agent/lib/memory-extraction-repository.integration.test.ts`,
  `agent/lib/memory-explicit-claim-evidence.integration.test.ts`,
  `agent/lib/memory-source-repository.integration.test.ts`.

### R2b. Unified timeline and automatic extraction — реализовано

- **Миграция:** schema foundation находится в `051`; reliability barriers добавлены отдельной `055`.
- **Код:** `agent/lib/conversation-timeline-repository.ts`,
  `agent/lib/memory-extraction-batch-coordinator.ts`,
  `agent/lib/memory-extraction-candidate-processor.ts`,
  `agent/lib/memory-extraction-worker.ts`, `scripts/memory-extraction-worker.ts`,
  `agent/channels/telegram.ts`.
- **Поведение:** personal/family/group timeline; 1000-entry retention; 50-entry / 12 000-character
  context and extraction bounds; exact turn batches; approved background catch-up; pre-provider
  family-member source filtering; terminal oversized/lost gaps; contiguous coverage; source author
  from PostgreSQL; current `telegramTimelineSequence` turn marker; one claim writer; extraction worker
  starts only after healthy embedding service in development, test and production Compose graphs.
- **Тесты:** `agent/lib/r2b-unified-timeline-extraction.integration.test.ts`,
  `agent/lib/memory-family-extraction-authorization.integration.test.ts`,
  `agent/lib/memory-semantic-extractor.test.ts`,
  `agent/lib/memory-extraction-worker.test.ts`,
  `agent/lib/memory-reliability.integration.test.ts`, `agent/lib/memory-retrieval.test.ts`,
  `compose-runtime.test.ts`.

### R3. Verified subjects and profiles — реализовано

- **Миграции:** `migrations/052_r3_verified_profiles.sql` и review-fix
  `migrations/056_profile_projection_notice_delivery.sql`.
- **Код:** `agent/lib/profile-selection.ts`, `agent/lib/profile-view-repository.ts`,
  `agent/lib/profile-projection-policy-repository.ts`,
  `agent/lib/external-profile-projection-predicate.ts`,
  `agent/lib/memory-sensitive-approval-repository.ts`, `agent/lib/memory-source-repository.ts`.
- **Поведение:** chat-local verified subjects and immutable profile views; 4 subjects / 12 000 chars,
  30 claims and 8 000 chars per subject; 60-day non-destructive dormancy; sensitive always excluded;
  external self-projection default-off and visible only after explicit current-owner opt-in **and**
  confirmed delivery of the matching versioned notice; retrieval и source lookup используют один
  strict external projection predicate; personal export contains authoritative personal claims only.
- **Тесты:** `agent/lib/r3-profile-migration.integration.test.ts`,
  `agent/lib/r3-profile-projection.integration.test.ts`,
  `agent/lib/r3-external-projection-retrieval.integration.test.ts`,
  `agent/lib/memory-source-repository.integration.test.ts`, `agent/lib/profile-selection.test.ts`,
  `agent/lib/telegram-profile-turn.test.ts`.

### R4. Conflicts — реализовано

- **Миграция:** `migrations/053_r4_r5_claim_consolidation.sql`.
- **Код:** `agent/lib/memory-conflict-repository.ts`,
  `agent/lib/tools/manage_memory_conflict.ts`, `agent/lib/memory-retrieval-repository.ts`.
- **Поведение:** same-zone conflict relations, retrieval closure, grouped model context, opaque refs,
  both-or-none suppression при недоступном partner, role revalidation, replay-safe HITL resolution and
  audit; losing claims are retracted, not deleted.
- **Тесты:** `agent/lib/r4-r5-consolidation-migration.integration.test.ts`,
  `agent/lib/memory-conflict-repository.integration.test.ts`,
  `agent/lib/memory-retrieval-repository.integration.test.ts`,
  `agent/lib/r3-external-projection-retrieval.integration.test.ts`,
  `agent/lib/manage-memory-conflict-tool.test.ts`.

### R5. Similar claims and lifecycle — реализовано

- **Миграция:** `migrations/053_r4_r5_claim_consolidation.sql`.
- **Код:** `agent/lib/memory-relation-classifier.ts`,
  `agent/lib/memory-consolidation-guards.ts`,
  `agent/lib/memory-consolidation-job-repository.ts`,
  `agent/lib/memory-consolidation-worker.ts`, `agent/lib/memory-claim-writer.ts`.
- **Поведение:** bounded same-zone candidate search; closed relation taxonomy; guards for negation,
  numbers, dates, source and mutable/stable properties; nondestructive duplicate/refinement/update/
  correction/conflict transitions; explicit edit creates an evidenced correction from the current
  timeline source instead of rewriting in place; terminal provider attempts without hidden retries.
- **Тесты:** `agent/lib/memory-relation-classifier.test.ts`,
  `agent/lib/memory-consolidation-guards.test.ts`,
  `agent/lib/memory-consolidation-worker.test.ts`,
  `agent/lib/memory-reliability.integration.test.ts`.

### R6. Memory threads and briefs — реализовано

- **Миграция:** `migrations/054_r6_r7_memory_threads.sql`.
- **Код:** `agent/lib/confirmed-outcome-repository.ts`,
  `agent/lib/memory-thread-coordinator.ts`, `agent/lib/memory-thread-query-repository.ts`,
  `agent/lib/memory-thread-brief-repository.ts`,
  `agent/lib/memory-thread-lifecycle-repository.ts`,
  `agent/lib/memory-thread-notice-repository.ts`.
- **Поведение:** verified-subject и scoped project threads; authoritative confirmed outcomes;
  source-backed entries and briefs; synchronous invalidation; retrieval/skill/title activation;
  one-time deferred notice acknowledged only after confirmed Telegram delivery; broad roots, one
  subthread level, verified completion episode and explicit reactivation; evidenced correction
  transfers active thread membership and retracts stale completion projections. Context defaults:
  2 threads / 16 000 chars, brief 6 000 chars / 20 items, 3 episodes, history page 20 entries /
  12 000 chars.
- **Тесты:** `agent/lib/r6-r7-memory-thread-migration.integration.test.ts`,
  `agent/lib/memory-thread-repository.integration.test.ts`,
  `agent/lib/memory-thread-brief.test.ts`,
  `agent/lib/memory-completion-source-invalidation.integration.test.ts`,
  `agent/lib/memory-r6-trust-zone-cascade.integration.test.ts`.

### R7. Advanced candidates, recovery discovery and decay — реализовано

- **Миграции:** `migrations/053_r4_r5_claim_consolidation.sql` и
  `migrations/054_r6_r7_memory_threads.sql`.
- **Код:** `agent/lib/memory-extraction-candidate-processor.ts`,
  `agent/lib/memory-thread-discovery-policy.ts`,
  `agent/lib/memory-thread-discovery-repository.ts`,
  `agent/lib/memory-thread-discovery-worker.ts`, `agent/lib/memory-retrieval-repository.ts`.
- **Поведение:** source-required candidates; content/duplicate/conflict guards; sensitive HITL;
  immediate and recovery thread discovery with 3 claims / 2 batches / 90 days; ranking recency decay
  without destructive expiry.
- **Тесты:** `agent/lib/memory-thread-discovery.test.ts`,
  `agent/lib/memory-thread-worker.test.ts`,
  `agent/lib/memory-extraction-candidate.test.ts`,
  `agent/lib/memory-content-policy.test.ts`,
  `agent/lib/memory-retrieval-eval.integration.test.ts`.

### Independent reliability audit — реализовано

- **Opaque IDs:** `049` и opaque refs в `051`-`054`; проверяются model/tool/thread/profile tests.
- **Provenance:** `051`, `claim_evidence`, `memory-source-repository.ts`; old rows честно остаются
  `legacy_unresolved`/non-endorsed, nullable live source links не стирают retained metadata.
- **HITL:** exact tool call evidence (`tool_call_id`, `tool_name`, full input hash), current
  identity/role revalidation и replay protection в `052`, `require-tool-approval-evidence.ts` и
  `telegram-hitl/approval-repository.ts`. Все sensitive/destructive memory tools проверяют evidence
  перед repository mutation; это покрыто `memory-tool-results.test.ts`, `manage-memory-tool.test.ts`,
  `manage-memory-conflict-tool.test.ts`, `manage-profile-projection-tool.test.ts` и
  `telegram-hitl/approval-repository.integration.test.ts`.
- **Retention holds and gaps:** `migrations/055_memory_reliability_barriers.sql`,
  `memory-extraction-progress-repository.ts`, `memory-reliability.integration.test.ts` и
  `memory-family-extraction-authorization.integration.test.ts`; lost, unauthorized and oversized
  entries получают terminal diagnostics, а contiguous cursor не перескакивает недоказанный range.
- **Cleanup:** terminal plaintext erasure and recovery scan in
  `memory-extraction-job-repository.ts`; `pending`, `resolution_processing`, `approval_pending`,
  `consolidation_pending` и `resolution_failed` блокируют erasure всего snapshot. Это сохраняет
  plaintext для явного recovery/diagnostics, пока каждый sibling candidate не получит безопасное
  terminal resolution; покрыто `memory-reliability.integration.test.ts`.
- **Outbox:** `telegram-final-delivery.ts`, `telegram-final-delivery-repository.ts` and
  `telegram-final-delivery.test.ts`; ambiguous Telegram acceptance is never auto-resent.
- **Notices:** thread notices из `055` и profile projection notices из `056` получают durable
  delivery state; `presented` фиксируется только после confirmed send. Profile projection остаётся
  fail-closed до delivered notice текущей policy version. Stale `started` thread notice становится
  terminal `ambiguous`, больше не выбирается для отправки и не блокирует отдельный более новый
  `pending` notice. Покрыто `memory-thread-notice.test.ts`,
  `memory-thread-notice-repository.integration.test.ts`, `telegram-profile-turn.test.ts`,
  `r3-profile-projection.integration.test.ts` и
  `r3-external-projection-retrieval.integration.test.ts`.
- **Projection/source authorization:** retrieval и direct source lookup импортируют единый
  `external-profile-projection-predicate.ts`; strict policy, provenance, subject и notice checks не
  расходятся между путями. Покрыто `memory-source-repository.integration.test.ts` и
  `r3-external-projection-retrieval.integration.test.ts`.
- **Conflict closure:** `memory-retrieval-repository.ts` возвращает unresolved conflict только когда
  обе стороны одновременно проходят full authorization. Недоступный partner подавляет весь набор,
  включая выбранную сторону, и не раскрывает partner content или metadata.
- **Production release predicate:** `scripts/production-deploy/release.sh` проверяет resolved Compose
  JSON, а не только исходный YAML: запрещает privileged/host namespace/build/devices/cap additions,
  требует bounded JSON logs, exact service mount tuples, три read-only bind mount файла
  `/opt/osinara/model-providers.json` и единственный loopback edge port. Тест
  `production-release-contract.test.ts` исполняет реальную Bash/`jq` функцию на допустимом fixture и
  доказывает fail-closed отказ при добавлении постороннего bind mount; это executable contract, а не
  текстовая проверка наличия predicate.
- **Correction provenance:** `manage_memory.edit` требует current timeline source, создаёт evidenced
  version chain и переносит thread membership до retirement старого claim; покрыто
  `memory-repository.integration.test.ts` и
  `memory-completion-source-invalidation.integration.test.ts`.
- **Worker crash semantics:** extraction, candidate resolution, consolidation, discovery and brief
  leases become explicit terminal failures; `memory-worker-loop.ts` drains the active step on shutdown.
  Covered by `memory-extraction-worker.test.ts`, `memory-worker-loop.test.ts`,
  `memory-consolidation-worker.test.ts`, `memory-thread-worker.test.ts` and
  `memory-thread-brief.test.ts`.

### Final review verification

- Release `0.11.0`; R0-R7 сохраняют статус **реализовано**.
- Последний завершённый test run: **1260 tests passed, 1 skipped**.
- Последний завершённый dependency audit: **`npm audit` — 0 vulnerabilities**.
- Release gates для перечисленных review blockers имеют статус **complete**. Финальный fresh-DB
  Docker Compose rerun, typecheck, runtime/Eve build, manifest, audit и diff checks завершены успешно.
  Независимый итоговый audit: **P0 = 0, P1 = 0, P2 = 0**.

---

## 15. Что утверждено и что ещё уточняется

### 15.1 Утверждено

1. Agent автоматически сохраняет устойчивые факты, события, интересы, предпочтения и решения.
2. Одноразовое, быстро устаревающее и сомнительное автоматически не сохраняется.
3. Sensitive хранится только после approval; secrets и платёжные данные запрещены content policy.
4. Оперативная timeline хранит последние 1000 logical entries.
5. В model context автоматически входит не более 50 entries / 12 000 символов.
6. Timeline реализована для personal, family-private и external путём эволюции существующего boundary.
7. Hybrid retrieval сохраняет embeddings и использует versioned eval и relevance thresholds.
8. Vector store является индексом, а не source of truth.
9. Profiles и thread briefs являются projections, а не копиями памяти; memory thread хранит только
   scoped identity и проверяемые связи с source records.
10. Weekly cron summaries не входят в целевую обязательную архитектуру.
11. Similarity не выполняет destructive merge.
12. Conflicts возвращаются комплектом и не разрешаются моделью самостоятельно.
13. Generic entity graph, bitemporal model и неограниченный similarity-based supersede не входят в
    реализованную архитектуру.
14. Auto-extraction не создаёт второй writer и проходит существующий repository boundary.
15. Каждый model-visible group bootstrap/delta batch рассматривается для извлечения полезных фактов.
16. Автор и source автоматического claim из group delta выводятся из PostgreSQL timeline entry, а не
    из caller сообщения, которое запустило turn.
17. Conversation cursor и memory-extraction cursor/range state независимы: успешный ответ не имеет
    права скрыть failed или пропущенный extraction batch.
18. Автоматически сохраняются только сведения с долговременной ценностью; бытовые команды,
    одноразовые просьбы, настроение, вопросы и предположения остаются в timeline.
19. Каждый независимый смысл сохраняется отдельным атомарным claim без потери отрицания, даты и
    существенных уточнений.
20. Полезное утверждение verified члена семьи о другом члене сохраняется как `reported` с автором
    исходной реплики и не считается endorsement человека, о котором идёт речь.
21. Consolidation использует закрытые отношения `new`, `duplicate`, `refinement`, `temporal_update`,
    `correction` и `conflict`; LLM предлагает отношение, repository проверяет переход.
22. Старые версии не удаляются: duplicate добавляет evidence, а refinement/update/correction хранит
    provenance через lifecycle relation.
23. Более поздний прямой claim того же человека автоматически обновляет его изменяемое состояние,
    план или предпочтение. Поэтому «люблю кофе», а через год «не люблю кофе» — temporal update.
24. Стабильный профильный факт не заменяется только из-за более поздней даты: нужна явная correction;
    несовпадение разных источников остаётся conflict.
25. Профиль уникален для пары origin conversation и verified subject; один пользователь имеет
    независимые профили в разных чатах.
26. Personal claims никогда автоматически не переходят в family или external scopes.
27. Personal context может читать authorized family claims и claims о самом verified пользователе из
    внешних групп только при включённой owner-managed policy и confirmed delivery notice её текущей
    версии. Это входящая read projection, а не копирование в personal scope.
28. External groups полностью изолированы друг от друга и не получают personal/family memory.
29. После owner opt-in и confirmed notice delivery external `reported` claims о verified пользователе
    доступны ему в personal projection только с source author и origin group и не считаются его
    endorsement.
30. В group context автоматически входят только релевантные participant profiles, а не профили всех
    встречавшихся участников.
31. Выход из external group не удаляет её group-local participant profile. При действующей owner
    opt-in policy с delivered notice новые `reported` claims о бывшем участнике также могут поступать
    в его личку при доказанном subject binding. Возвращение того же Telegram `user_id` продолжает
    прежний профиль.
32. Username и nickname не являются identity keys. Идентичность и last activity выводятся из
    verified Telegram user ID и durable timeline; 60 дней inactivity исключают dormant subject только
    из automatic profile selection и не удаляют claims/history/retrieval.
33. Каждый claim, доступный через входящую projection, сохраняет origin chat, source author, время,
    evidence snippet и opaque source ref. Агент может выполнить scoped lookup и объяснить
    пользователю, где и когда сведения были получены.
34. Долгоживущая тематическая сущность называется «нить памяти» (`memory_thread`, по-английски
    `thread`). Её цели, ограничения, методы, решения, эпизоды, outcomes и уроки остаются отдельными
    source-backed records.
35. Живой бриф нити является bounded projection с source refs. Он не содержит unsupported фактов,
    инвалидируется при изменении источников и загружается только при активации темы.
36. Нити создаются автоматически без confirmation двумя путями: online semantic proposal и backend
    recovery detection повторяющихся scoped claims. Оба пути используют один idempotent coordinator.
37. Векторы и частота являются только candidate generation. Создание или attach требует bounded
    semantic classification и application validation subject/scope/source.
38. После committed creation пользователь получает одно уведомление. Background creation не будит
    пользователя, а показывает durable notice при следующем разрешённом turn; `presented` фиксируется
    только после confirmed Telegram delivery.
39. Найденный claim может автоматически активировать связанную нить; в context добавляются bounded
    thread brief и релевантные episodes, а не вся история.
40. Thread discovery использует два gate: immediate semantic creation при явной продолжающейся
    деятельности и backend recovery после минимум 3 claims из 2 source batches за 90 дней. Числа
    запускают classifier, но не заменяют semantic решение.
41. Один authoritative claim может входить в несколько нитей того же verified subject и scope без
    копирования текста или evidence. Lifecycle source record инвалидирует все связанные briefs, а
    context assembly дедуплицирует общий claim.
42. Нити создаются broad-first. Focused subthread автоматически выделяется только при собственной
    долгосрочной цели или методике и повторяющихся эпизодах; глубина ограничена root + один subthread,
    а выделение не перемещает и не копирует source records.
43. Завершённая focused thread сохраняется целиком и получает компактный source-backed completion
    episode. Parent thread ссылается на него как на историческое событие, а полный brief загружается
    только по релевантному запросу.
44. Initial thread context ограничен двумя нитями и 16 000 символов; один brief — 6 000 символов и
    20 items, одна нить — до 3 episode representations по 2 000 символов. Недостающая история
    загружается bounded страницами 20 entries / 12 000 символов.
45. Background catch-up включён и bounded обрабатывает retained uncovered timeline entries, даже если
    они не входили в model-visible turn. Family-private non-member entries terminally исключаются до
    provider, oversized entry становится explicit terminal gap, а cursor продвигается только через
    contiguous coverage/gaps.
46. Telegram forum topic является `message_thread_id` source partition внутри chat-level conversation;
    retention, profile и trust boundary остаются на уровне чата.
47. External self-projection default-off. Включить её может только актуальный owner явным
    replay-protected exact-HITL действием; projection остаётся fail-closed, пока versioned notice не
    подтверждён как доставленный группе.
48. Personal export содержит только authoritative personal claims пользователя и не включает
    входящие family/external projections.
49. Старые rows сохранены как `active + legacy_unresolved`, без endorsement и invented evidence.
50. Sensitive claims всегда исключены из always-on profile, даже после approval; per-claim override
    не существует.
51. Exact provider/HITL/outbox side effects имеют durable evidence и terminal crash semantics. Все
    sensitive/destructive memory tools проверяют exact consumed tool call + full input hash до
    mutation; ambiguous Telegram delivery и provider call автоматически не повторяются.
52. Current timeline turn определяется только `telegramTimelineSequence`; stale
    `telegramGroupTimelineSequence` игнорируется. Explicit correction требует current timeline source,
    создаёт evidenced version и переносит active thread membership до supersede старого claim.

### 15.2 Будущие продуктовые вопросы

Ни один пункт ниже не является незакрытым review finding или дефектом R0-R7; это отдельные
неутверждённые расширения текущего контракта.

1. Нужен ли отдельный пользовательский action для удаления timeline entry, или достаточно retention
   и удаления долговременного claim.
2. Что происходит с family claims о человеке после прекращения его membership: остаётся текст без
   verified subject binding или запись удаляется по отдельной privacy policy.
3. Нужна ли временная граница retention дополнительно к утверждённым 1000 entries.
4. Какой end-to-end redaction/retention contract применяется к сообщению, где одновременно есть обычный текст
   и secret: raw ingress, timeline representation, model context и erasure должны быть определены
   отдельно.
5. Нужны ли temporal historical intervals `valid_from`/`valid_to` сверх `observed_at`, episode ordering
   и `superseded_by`.
6. Как user-requested erasure должна охватывать raw ingress, attachments, ранее созданные exports,
   backups и допустимый audit metadata без нарушения обязательного аудита.

Эти medium/future вопросы требуют отдельного persisted или privacy contract и не решаются
предположением в текущем коде.

---

## 16. Журнал решений

### 2026-07-18

- Оперативная память определена как application-owned PostgreSQL timeline, а не Eve history.
- Лента включает обе стороны разговора, artifacts и outcomes, но не внутренние tool/model events.
- Timeline передаётся как недоверенный контекст.
- Scope определяется только verified auth.

### 2026-07-28

- Существующий `telegram_group_messages` выбран основой единой групповой timeline.
- Retention установлен в 1000 logical entries на зарегистрированную группу.
- Введены transport aliases и monotonic sequence IDs.
- Forum topic определяется только raw verified Telegram update.

### 2026-07-30

- Новая group session получает bootstrap-окно, продолжение — incremental delta после cursor.
- Bootstrap ограничен 50 entries и 12 000 символов.
- Ответы агента связываются с originating application session.
- Reply и attachment routing не зависят от recent context window.

### 2026-08-07

- Подтверждено, что автоматическое сохранение устойчивых фактов, событий, интересов, предпочтений и
  решений уже является продуктовым контрактом и сохраняется без отдельного уведомления.
- Лимит 1000 logical entries принят целевым количественным retention для unified timeline;
  автоматическое окно остаётся 50 entries / 12 000 символов.
- Согласована эволюция существующей timeline на personal и family-private scopes.
- Vector storage зафиксирован как retrieval index, а `memory_items` — как основа authoritative claims.
- Отдельный вечный evidence store, generic entity graph, bitemporal model, weekly cron summaries и
  неограниченный similarity-based supersede исключены из целевой первой версии.
- Профили определены как bounded projections claims; тематические summaries заменены нитями памяти и
  on-demand thread briefs с source IDs.
- Конфликты определены как scoped relation с обязательным co-retrieval; similarity не выполняет
  destructive merge.
- Зафиксирована обязательная обработка всей model-visible group delta: отдельный bounded LLM pass
  предлагает candidates с primary/supporting timeline sequences, а application repository
  восстанавливает настоящего автора и source из PostgreSQL. Caller, запустивший turn, не считается
  автором чужих реплик.
- Conversation context cursor отделён от durable memory-extraction range state, чтобы успешный ответ
  не приводил к необнаружимой потере фактов при сбое extraction.
- Утверждён критерий automatic save: claim должен быть полезен после текущего разговора; команды,
  одноразовые бытовые просьбы, случайные состояния, вопросы и предположения остаются только в
  timeline. Независимые смыслы сохраняются атомарно.
- Сведения одного verified члена семьи о другом сохраняются автоматически как `reported` с точным
  source author. Такой claim не считается подтверждённым его субъектом; последующее отрицание
  создаёт конфликтный набор, а не молчаливую замену.
- Утверждена closed consolidation taxonomy: `new`, `duplicate`, `refinement`, `temporal_update`,
  `correction`, `conflict`. LLM только классифицирует relation, а repository проверяет source, scope,
  subject, property и допустимость lifecycle transition.
- Прямое более позднее высказывание человека автоматически обновляет его изменяемые предпочтения,
  планы и состояния с сохранением старой версии. Стабильный факт требует явной correction, а
  несовпадение разных источников остаётся видимым конфликтом.
- Профили определены как chat-local projections для каждого встретившегося verified участника. Один
  пользователь имеет независимые profiles в разных внешних чатах; в turn подаются только профили
  автора, reply/mention subjects и найденных retrieval subjects.
- Утверждена направленная видимость: personal claims не выходят наружу; family claims доступны в
  personal context; external groups изолированы, а потенциальная inward projection `firsthand` и
  `reported` claims сохраняет source author и origin group. Финальный default-off/opt-in contract
  зафиксирован решением 2026-08-08 ниже.
- Входящая personal visibility реализуется ссылочной read projection без копирования или изменения
  origin claims. Межскоуповые совпадения и расхождения могут группироваться только при чтении и не
  создают persisted merge/supersede/conflict relations.
- Выход из external group не удаляет локальный профиль участника. При разрешённой policy и delivered
  notice текущей версии новые `reported` claims после выхода также могут поступать в personal
  projection при доказанной subject identity. Возвращение определяется по Telegram user ID, а не по
  изменяемому username; inactivity не является основанием для удаления.
- У каждого projected claim сохраняются durable origin chat, source author, time и evidence snippet.
  Opaque source lookup позволяет агенту ответить, где и когда факт был упомянут; если timeline уже
  очищена retention, отсутствие полного исходного сообщения сообщается честно.
- Для долгоживущих тематических историй утверждено название «нить памяти» (`memory_thread` / `thread`).
  Нить связывает отдельные source-backed goals, constraints, methods, decisions, episodes, outcomes и
  lessons; её живой бриф является перестраиваемой bounded projection, а не новым источником истины.
- Нить создаётся автоматически без confirmation: online LLM замечает намерение продолжать
  деятельность, а backend recovery path ищет пропущенные повторяющиеся scoped clusters. Векторы лишь
  отбирают candidates; единый coordinator проверяет semantics, subject, scope, sources и idempotency.
- После создания показывается одно короткое уведомление. При будущем retrieval membership найденного
  claim автоматически поднимает bounded brief соответствующей нити и релевантные эпизоды.
- Для thread discovery утверждены два gate: immediate semantic path при явном намерении продолжать
  деятельность и recovery path с production defaults 3 claims / 2 source batches / 90 дней. Порог
  лишь запускает bounded classifier и калибруется отдельным false-create/miss eval.
- Один source-backed claim может входить в несколько нитей одного subject/scope. Хранится одна
  authoritative запись и несколько validated links; одновременная загрузка нитей не дублирует claim
  в model context.
- Утверждена broad-first granularity: «Тренировки» или «Инвестиции» создаются как широкие root threads;
  самостоятельная повторяющаяся программа может автоматически стать focused subthread. Допустим
  только один уровень, split не копирует и не перемещает claims.
- Завершение focused thread фиксируется только проверяемым событием. Полная нить остаётся доступной,
  а parent получает компактный completion episode с source refs; завершённый brief не занимает
  обычный контекст, но поднимается релевантным историческим запросом.
- Для initial thread context утверждены defaults: максимум 2 активные нити / 16 000 символов; brief
  до 6 000 символов и 20 source-backed items; до 3 episode representations на нить. Более глубокая
  история читается отдельным bounded lookup 20 entries / 12 000 символов.
- Readiness audit добавил обязательный R0 для model-safe opaque refs и удаления destructive dedup
  prompt. Timeline/extraction разделены на R2a provenance foundation и R2b automatic extraction;
  profiles, conflicts и threads нельзя строить до завершения этих prerequisites.
- Развитие разбито на последовательные вертикальные релизы R1–R7 с отдельным пользовательским
  результатом и verification gate на каждом этапе.

### 2026-08-08

- R0-R7 реализованы миграциями `049`-`054` и application modules, перечисленными в разделе 14.
- Утверждён и реализован bounded background catch-up для retained entries, не попавших в turn batch.
- Conversation identity закреплена за Telegram chat; forum topic остаётся source partition metadata
  внутри chat-level timeline/profile boundary.
- 60-day dormancy реализована недеструктивно только для automatic profile selection.
- External self-projection закреплена как default-off; включение доступно только актуальному owner и
  требует confirmed delivery versioned notice группе. Миграция `056` блокирует projection/retrieval/
  source lookup до `presented` notice текущей policy version. `inferred` external claims не
  проецируются.
- Personal export закреплён как authoritative-only: только personal claims владельца, без входящих
  family/external projections.
- Legacy claims сохранены как `legacy_unresolved` и non-endorsed; backfill не создаёт evidence.
- Sensitive claims всегда исключены из always-on profile, даже после approval.
- Независимый reliability audit добавил миграцию `055`: extraction retention holds и explicit gaps,
  terminal candidate leases, recovery cleanup, thread/approval delivery states и durable Telegram
  final-delivery outbox.
- Family-private non-member sources исключаются до snapshot/provider и повторно проверяются для всех
  primary/supporting authors перед persistence. Oversized entry terminally диагностируется без
  plaintext и не блокирует contiguous catch-up.
- HITL execution всех sensitive/destructive memory tools привязан к exact consumed tool call, full
  input hash и current verified authority.
- Current timeline turn определяется `telegramTimelineSequence`; stale legacy attribute не влияет на
  retrieval query. Explicit edit создаёт evidenced correction из current timeline source и переносит
  thread membership до retirement старой версии.
- Provider и Telegram crash ambiguity не запускают hidden retry; worker shutdown завершает активный
  durable step и не берёт новый.
- `memory-extraction-worker` во всех Compose variants ждёт healthy embedding service; production
  дополнительно ждёт migration gate.
- External retrieval и source lookup используют один strict projection predicate; unresolved
  conflicts выдаются только both-or-none, включая случай недоступного partner.
- Snapshot cleanup блокируется незавершёнными `resolution_processing` и terminal diagnostic
  `resolution_failed`; stale started thread notice становится terminal `ambiguous` и не отправляется
  повторно.
- Production deploy исполняет exact resolved-Compose security predicate для полного mount/port и
  root-capability surface; contract test запускает саму Bash/`jq` функцию и fail-closed unsafe fixture.
- Release `0.11.0`: финальный fresh-DB прогон дал 1260 passed / 1 skipped; `npm audit` сообщил
  0 vulnerabilities. Release gates и review blockers завершены.
