# Osinara Agent Guide

## Что это за проект

Osinara — семейный Telegram-агент на TypeScript, Eve `0.40.0`, PostgreSQL и Groq.
Он обслуживает личные чаты, закрытые семейные группы и изолированные внешние группы.
Главная задача приложения — сохранять строгие границы между пользователями, семьями и группами.

Основные возможности: bootstrap владельца, приглашения и подтверждение участников;
личные, семейные и групповые контексты с отдельной политикой доступа;
durable Telegram ingress, Groq Whisper, HITL, Eve tools, skills и sandbox.

## Framework

Проект закреплён на Eve `0.40.0`; не обновлять версию как побочный рефакторинг.
Eve — filesystem-first framework для durable backend agents.
Расположение файла определяет его роль и, как правило, runtime-имя.

Официальная документация: [https://eve.dev/docs](https://eve.dev/docs)
Исходный репозиторий: [https://github.com/vercel/eve](https://github.com/vercel/eve)
Точная документация установленной версии: `node_modules/eve/docs/README.md`.
Публичные TypeScript-типы: `node_modules/eve/dist/src/public/`.

Перед изменением Eve-facing кода:

1. Прочитать релевантный guide в `node_modules/eve/docs/`.
2. Проверить экспортированные типы установленной Eve, а не полагаться на память.
3. Проверить runtime source Eve, если документация не определяет важную семантику.
4. Использовать только публичные Eve API либо явно документированный локальный патч.

Полезные guides:

- layout и config: `node_modules/eve/docs/reference/project-layout.md`, `agent-config.md`;
- Telegram: `node_modules/eve/docs/channels/telegram.mdx`;
- durability и sessions: `node_modules/eve/docs/concepts/`;
- dynamic tools: `node_modules/eve/docs/guides/dynamic-capabilities.md`;
- HITL: `node_modules/eve/docs/tools/human-in-the-loop.md`;
- sandbox и subagents: `node_modules/eve/docs/sandbox.mdx`, `subagents.mdx`.

## Граница Eve и приложения

Eve отвечает за agent loop, модели, durable sessions, compaction и streaming.
Eve также отвечает за channels, tools, skills, sandbox, subagents и HITL protocol.

Osinara отвечает за пользователей, семьи, роли, membership и приглашения.
Osinara также отвечает за group registration, scopes, authorization, audit и long-term memory.

Никогда не переносить прикладную авторизацию в prompt или инструкции модели.
Никогда не принимать `userId`, `familyId`, роль, group type или scope из текста модели.
Источники доверия — проверенный channel update, session auth и актуальное состояние PostgreSQL.

Long-term memory является application concern, а не заменой Eve `defineState`.
Смысловое решение о сохранении claim и create/attach thread принимает только основной чат-агент
через `remember`. Backend выводит source/identity/scope из verified Telegram context и PostgreSQL и
коммитит claim, evidence, Eve provenance и optional thread entry одной транзакцией. Subagent не
получает `remember`. Background semantic extraction, relation/thread classifiers и LLM briefs удалены;
retrieval и thread activation используют только локальный E5 и scoped SQL.
Работа с фактами подтверждений не запрашивает: решение принимает агент. Страховкой служит мягкое
удаление — строка получает `deleted_at`, помечается отозванным заявлением и исчезает из всех чтений
и из векторной выдачи, потому что `memory_items` является представлением над `memory_items_all`.
Физически строка убирается ретенцией по истечении окна восстановления. Во внешней группе правка и
удаление памяти доступны только через явно выданные action-level capabilities и повторную live-
проверку актуального allowlist.
Перед edit/delete основной агент обязан прочитать полную текущую запись и самостоятельно проверить
смысловую целостность изменения. Обогащение сохраняет все ещё актуальные детали; недостаточно
обоснованная, обедняющая или скрывающая конфликт мутация отклоняется. Privacy-просьба автора удалить
собственные данные остаётся достаточным основанием. Backend независимо проверяет автора/owner,
активный memoryRef, version chain и soft delete; семантика не кодируется regex-эвристиками.

Проверка памяти группы идёт лейнами: один лейн на чат или тему форума, курсор двигает только
завершённый проход, а пара `(lane_id, predecessor_sequence)` уникальна, поэтому незакрытый пакет
держит место на курсоре и в одиночку останавливает весь лейн. Привязка хода к пакету живёт в самом
пакете (`eve_session_id`, `eve_turn_id`) и пишется на старте хода; метка в авторизации годится
только для того хода, который под ней начался, потому что ход, продолженный после ответа человека,
приходит с авторизацией этого ответа.

Судьбу пакета, чей ход уже не отчитается сам, решает одна функция `resolveAbandonedReviewBatch` под
блокировкой лейна, и решает по провенансу `eve:<session>:<turn>`, прочитанному из строки пакета, а
не из контекста канала. Записавший память ход засчитывается состоявшимся, потому что повтор создал
бы дубликаты. Ничего не записавший отдаёт источники в непроверенный хвост, но только пока за ним
никто не стоит: следующие пакеты цепляются за застрявшую голову, и её удаление оставило бы их
недостижимыми от курсора. При наследнике голова получает терминальный `skipped` — строка остаётся,
курсор проходит через неё, источники отпускаются. Терминалов, занимающих место на курсоре навсегда,
на этих путях больше нет.

Сюда сходятся шесть путей: ход упал; ход отменён следующим сообщением чата; подготовка хода не
удалась; сессия чата упала; ход не дошёл до Eve и привязки не получил, значит писать не мог; ход
дошёл до Eve и замолчал. Первые четыре приходят событием, последние два — минутной чисткой, причём
у замолчавшего есть временная граница, припаркованный ход не трогают (его видно по
`pending_operation` сессии), а исчезнувшую по ретенции сессию ждать уже незачем. Владельцу уходит
предупреждение `AGENT_MEMORY_REVIEW_PASS_SKIPPED` только когда сообщения действительно пропущены и
причина не в отмене: дописанное второе сообщение — обычное поведение живого чата, а не авария.
Сессию фоновой проверки закрывает тот же проход: `retireAbandonedTasks` её вида не знает, а живые
источники держали бы журнал группы от обрезки.

## Как проходит Telegram update

1. Docker Nginx принимает только разрешённые публичные маршруты.
2. Eve Telegram channel проверяет `TELEGRAM_WEBHOOK_SECRET_TOKEN`.
3. Локальный verified-update hook сохраняет исходный update в PostgreSQL до ACK.
4. Telegram быстро получает `200`, без ожидания модели или транскрибации.
5. `telegram-ingress-worker` вызывает закрытый drain route внутри Docker network.
6. Repository выдаёт update по FIFO для конкретного chat/topic и ставит lease.
7. Voice authorization повторно проверяется до обращения к Groq.
8. Native Eve Telegram dispatch запускает `handleTelegramMessage`.
9. Handler выводит auth и scopes только из Telegram и PostgreSQL.
10. Eve выполняет turn, tools, approvals и доставляет ответ через channel adapter.
11. Текст, написанный моделью до вызова инструмента, уходит отдельным progress notice.
12. Следующий item освобождается после session boundary либо по исчерпании одной аренды.

Нажатие кнопки никогда не попадает в Eve: непринятый прикладным обработчиком callback
логируется и завершается на месте. Ожидание session boundary ограничено сроком аренды
(`TELEGRAM_INGRESS_LEASE_MS`); по истечении запись становится терминальной с кодом
`AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT`, иначе одна незавершённая сессия глушит бота
полностью. Неудача одной записи больше не обрывает проход: очередь продолжает разбираться,
наружу пробрасывается только сбой, делающий дальнейшую работу невозможной.

Дедупликация основана на Telegram `update_id`.
Перед Groq и Eve dispatch сохраняются durable start markers.
После неоднозначного crash автоматический повтор запрещён, чтобы не удвоить оплату или side effect.

## Живая подача сообщений

Один ответ модели может стать несколькими Telegram-сообщениями. Границу выбирает модель отдельной строкой
`[[split]]`; приложение не проверяет длину, число абзацев и разметку частей. Единственный
предел в `agent/lib/telegram-authored-split.ts` ограничивает число сообщений с паузой: всё сверх
потолка приклеивается к последнему сообщению, текст не теряется. Директива является транспортным
синтаксисом и никогда не доходит до человека: отдельной строкой она делит ответ, в любом другом
месте вырезается, а внутри fenced или indented code остаётся содержимым ответа. Отменённое
тег-подобное написание `<telegram-split>` распознаётся наравне с текущим маркером, чтобы прежняя
привычка модели не утекала в чат. Reply-цитата стоит
только на первом сообщении; перед каждым следующим канал отправляет typing action и ждёт паузу из
`telegram-aside-pacing.ts`, привязанную к времени жизни индикатора Telegram. Правило длинного
ответа применяется к каждому сообщению отдельно. В scheduled runs дробление вырезается из текста.

Текст, написанный моделью до вызова инструмента, теперь доставляется как progress notice
(`agent/lib/telegram-progress-notice.ts`). Заявка в `telegram_progress_notices` по
`(eve session, turn, step index)` делается до отправки, поэтому повтор хода не дублирует отбивку;
сбой отправки логируется и не роняет turn, потому что ответ ещё готовится. Notices не попадают в
timeline и не выдаются в scheduled runs.

Набор допустимых реакций задаёт Telegram, а не приложение. Канал раз в сутки на чат обновляет
`available_reactions` через `getChat` и сохраняет ответ в `telegram_chat_reaction_policies`;
отсутствующее поле документировано как разрешение любых эмодзи, и этот случай объявляется полным
набором Telegram, который хранится в приложении рядом с валидатором реакций. Правила реакций живут
в блоке режима и одинаковы во всех чатах, поэтому блок остаётся байт-стабильным для prompt caching.
Сам набор объявляется отдельным user-сообщением истории `<telegram_chat_reactions>`: оно авторуется
один раз и переиздаётся только по отсутствию, потому что изменившийся набор даёт другой текст, а
compaction, убравший прежнее объявление, убирает и его условие. Когда реакции выключены или политика
неизвестна, ни раздела, ни объявления нет и агент отвечает текстом.

## Авторизация и scopes

`private` требует подтверждённую семейную identity.
Личный чат получает scopes `personal` и `family`.
`family_private` принимает только активного участника той же семьи и получает `family`.
`external` получает только собственный `group` scope.
Внешняя группа никогда не получает личную или семейную память и подключения.

## Напоминания

Простое напоминание доступно во всех типах чатов: в назначенное время бот сам присылает его текст.
Автономные агентные запуски остаются владельцу и только из личного чата; во внешней группе их нет.

Внешняя группа получает `list_reminders` и `manage_reminder` без выдачи прав, как часть постоянного
ядра интерактивного внешнего хода: `agent/lib/tool-policy/external-group-reminder-tools.ts`. Ни
scheduled run, ни ход от имени канала их не получают. Участник публичной группы не имеет учётной
записи, поэтому автором записи является проверенный Telegram user id, а не строка `users`; напоминание
живёт в scope `group` с пустыми `owner_user_id` и `author_user_id`.

Единственный лимит живёт в `reminder-config.ts` и считается по живым записям (`active`, `leased`,
`paused`): `GROUP_REMINDER_MAX_PER_CHAT` на чат, независимо от того, кто их поставил. Подсчёт и вставка идут в одной транзакции под advisory lock по группе, иначе двое одновременно
заняли бы один свободный слот. Часовой пояс публичного чата всегда `GROUP_REMINDER_TIMEZONE` и не
настраивается; тихие часы к нему не применяются, потому что это личная настройка человека.

Напоминание принадлежит чату, а не тому, кто его продиктовал: любой участник видит весь список,
включая приостановленные, и может изменить, приостановить, возобновить и удалить любую запись.
Автор записывается только как происхождение и на права не влияет; проверять его присутствие в чате
не требуется, поэтому обращений к Telegram при удалении нет. Доверенный путь до чужой зоны не
достаёт: `requireReminderMutationAccess` отклоняет scope `group`, а личный список его не
показывает. Групповая проактивная доставка
чат-уровневая по действующему контракту, поэтому напоминание уходит в общий чат, а не в тему форума.
Запись живёт, пока её чат остаётся той же внешней группой: минутный проход диспетчера иначе помечает
её `AGENT_REMINDER_DESTINATION_REVOKED`.

Owner-only операции разрешены только в личном Telegram-чате владельца.
После HITL side-effect executor должен повторно проверить текущую owner-role в БД.
Окно подтверждения собирает приложение: заголовок и факты выводятся из того же input, который уйдёт на исполнение, поэтому текст не может описывать одно действие, а выполнять другое. Запрос подтверждения не ждёт вечно: неотвеченные tool-approval и вопрос отменяются через пять минут, tool не исполняется, turn продолжается, а пользователь получает предупреждение и не получает повторный запрос без явной просьбы. Framework `session-limit` и OAuth в это окно не входят.
Изменение типа группы пересоздаёт trust zone и удаляет данные старой области.

Весь прикладной tool surface выдаётся per-mode через step-scoped Eve `defineDynamic` в `agent/tools/capabilities.ts`.
Статических дескрипторов у приложения нет: инструмент, недоступный текущему режиму, не имеет дескриптора вообще, а не заменяется заглушкой.
Реализации инструментов лежат в `agent/lib/tools/`; в `agent/tools/` остаётся только dynamic resolver, иначе дескриптор станет виден во всех режимах.
Матрица режимов и внешний allowlist собираются в `agent/lib/tool-policy/mode-tool-surface.ts`; сбой резолвера или недоказанный режим означает отсутствие прикладных инструментов.
Нативные контракты `glob`, `grep`, `read_file` и `write_file` во внешней группе перекрываются same-name dynamic wrappers: каждый execute повторно проверяет актуальную external registration, принимает только канонический путь внутри точного `/workspace/group` и запрещает symlink-компоненты до вызова Eve default executor. Единственное read-only исключение: `read_file` после live-проверки skill grant канонизирует supporting file видимого code-reviewed dynamic skill в `$HOME/.agents/skills`; `glob`, `grep` и `write_file` такого доступа не получают. В trusted private/family режимах wrappers не выдаются, поэтому исходные Eve built-ins сохраняют personal/family mounts и tools environment.
Eve `0.40.0` не умеет скрывать собственные built-ins per-session, поэтому `bash`, `todo` и `ask_question` во внешней группе перекрываются явным отказом. `web_fetch` выдаётся только через локальный controlled wrapper с execution-time проверкой; provider-native `web_search` не имеет local execution hook, поэтому всегда запрещён и не является grantable capability. `load_skill` обёрнут отдельной live-проверкой: он загружает только code-reviewed skill из актуального per-group skill allowlist либо capability-coupled `imagegen` при live grant `generate_image`.
Subscription-backed `generate_image` существует только при активном provider `codex-subscription`: при любом другом provider он не имеет дескриптора ни в одном режиме и отсутствует в owner-facing grant contract, поэтому включить его нельзя. В private/family он доступен интерактивному root-agent; внешней группе владелец выдаёт capability через `manage_telegram_group.update_policy` из личного чата с HITL и повторной owner-role проверкой. Grant одновременно открывает dynamic skill `imagegen`; execution повторно читает live group policy. Scheduled turns и subagents не получают ни tool, ни skill. Перед единственным вызовом `gpt-image-2` создаётся durable operation ledger; transport, 5xx и повреждённый success остаются terminal ambiguous без автоматического retry. Подтверждённый WebP сохраняется в authorized workspace и отправляется через exact-once `send_workspace_file`. CLIProxy запускается с `disable-image-generation: chat`, поэтому его скрытый provider tool не обходит application capability surface. Grant surface собирается в `agent/lib/tool-policy/grantable-group-capabilities.ts`: `manage_telegram_group` и registration принимают только capability, которую активный provider реально обслуживает, а grant, сохранённый под прежним provider, остаётся parseable, показывается в status как `unavailableConfiguredTools` и не выдаёт ни tool, ни skill.
Eve `0.40.0` materializes dynamic skill packages и их supporting files в sandbox на `session.started` или `turn.started`. Grantable `pohuy` остаётся вне static discovery и выдаётся turn-scoped resolver только разрешённым группам; folder, записанный посреди turn, не меняет текущий manifest и может появиться только через resolver на следующем turn.
Restricted group sandbox держит `$HOME` на Docker tmpfs. Docker `putArchive` не пишет надёжно прямо в mount target, поэтому runner file I/O загружает bytes во временный rootfs path и переносит их внутрь контейнера; не возвращать прямой archive write без реального tmpfs smoke.
Trusted sandbox подключён только к internal egress network и выходит наружу через `sandbox-egress-proxy`. Для Node CLI runtime задаёт `NODE_USE_ENV_PROXY=1`; официальный Russian Trusted Root CA закреплён в sandbox image и передаётся через `NODE_EXTRA_CA_CERTS`, чтобы T-Invest HTTPS проходил проверку без отключения TLS. Restricted group sandbox не получает эти переменные и остаётся без сети.
Нативный Eve `agent` используется для сложной работы только в trusted private/family режимах, где полезен свежий контекст. Во внешней группе same-name dynamic denial не позволяет запускать child и delegation prompt не выдаётся. Trusted child получает отдельные history и state и наследует проверенный auth, connections, skills, sandbox, workspace и trust-zone tools текущего parent turn, кроме root-owned `remember` и `generate_image`. В Eve `0.40.0` implicit `agent` доступен только root runtime node, поэтому child не может рекурсивно делегировать и удалённый `maxSubagentDepth` больше не нужен. Synthetic `session-limit` из Eve никогда не показывается во внешней группе: channel boundary завершает такой turn до parking, persistence и Telegram delivery.

## Структура проекта

`agent/agent.ts` — модель и compaction; root-only delegation задаётся нативной семантикой Eve.
`agent/instructions.md` — постоянное mode-agnostic ядро промта, не authorization layer.
`agent/instructions/` — пять turn-scoped dynamic блоков; порядок задан именами файлов: режим, делегация, стиль, набор реакций, память.
`agent/channels/telegram.ts` — Telegram channel, events и durable ingress hooks.
`agent/tools/capabilities.ts` — единственный discovered application tool и dynamic surface текущего режима.
`agent/lib/tools/` — реализации model-facing typed tools; имя берётся из имени файла.
`agent/lib/image-generation/` — provider gate, no-retry transport, durable ledger, skill и external presentation генерации изображений.
`agent/lib/reminders/` — напоминания всех областей: доверенный и групповой boundary, общая мутация, диспетчер.
`agent/lib/prompt/` — фрагменты промта и композиция блоков по режимам.
`agent/skills/` — активные статические Eve skills и dynamic resolver для grantable group skills.
`agent/lib/` — application logic, repositories, policies и colocated tests.
`agent/sandbox.ts` — явный backend `just-bash` без настроенных network commands.
`migrations/` и `scripts/` — schema, migration runner, bootstrap, Eve patch и workers.
`infra/nginx.conf` и `compose.yaml` — edge allowlist и Docker services.

Не размещать `*.test.ts` в `agent/tools/` или `agent/channels/`.
Eve discovery воспримет такой файл как production tool или channel.
Тесты model-facing модулей размещать рядом по смыслу в `agent/lib/`.

## Локальный патч Eve

Eve `0.40.0` не предоставляет все application seams для durable Telegram ingress.
`scripts/apply-eve-patches.ts` добавляет verified-update/drain hooks, возврат Session,
application routing/HITL contracts, fail-closed `input.requested`, verified task-origin auth,
ограничение root delegation и пятиминутное ожидание health при холодном старте.

Восстановлением после сбоя model call управляет сама Eve, патч в это не вмешивается. Её классификатор
повторяет только транспортные по форме сбои (408, 409, 429, 5xx, явно retryable и catalog-transient)
и никогда неверный запрос или ошибку конфигурации; повтор оборачивает один вызов модели, а tool calls
выполняются после его возврата, поэтому переиздание не повторяет побочный эффект. Повторы AI SDK
закрывают только неустановленное соединение: поток, оборвавшийся после начала ответа, восстановим
исключительно этим внешним слоем. Отдельные exact-once барьеры приложения (Telegram delivery,
progress notices, ledger генерации изображений) от этого независимы и остаются без автоповторов.
Патч применяется автоматически через `postinstall` после каждого `npm ci`.
Он идемпотентен, проверяет точную версию и ожидаемые artifacts; несовпадение должно останавливать сборку.

Не редактировать `node_modules/eve` вручную.
Не обходить ошибку patch mismatch строковой заменой без повторного аудита upstream source.
При обновлении Eve сначала проверить, появился ли официальный эквивалент, и удалить патч.

## Правила изменения архитектуры

Сначала читать существующий flow и тесты, затем писать failing test, потом implementation.
Предпочитать расширение существующего application boundary новому параллельному пути.
Не создавать второй Telegram transport, второй voice pipeline или второй auth mechanism.
Не дублировать Eve agent loop, HITL, channel delivery, compaction или skill discovery.
Required config и required data проверять fail-fast; не добавлять бизнес-fallbacks.
Ошибки должны иметь стабильный код и понятное русское user-facing сообщение.
Новый source-файл не должен превышать 500 строк; близкий к лимиту модуль разделять.

## Проверка изменений

Быстрые проверки: `npm run typecheck`, `npm test`, `npm run build`.
Главная проверка выполняется в Docker Compose:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
```

Migrations выполнять только внутри backend/test container через `npm run migrate`.
После Eve-facing изменений обязательно проверять чистый `npm ci` и `eve build`.
После tool/channel edits запускать `npm run build` и проверять свежий discovery в
`.output/.eve/discovery/agent-discovery-manifest.json`: `eve build` пишет artifacts только под
`.output/.eve/`, а `npm run build` дополнительно валидирует скомпилированный dynamic tool resolver
в `.output/server/index.mjs`. Тот же путь показывает, попал ли новый instructions-блок в сборку и в
каком порядке.
Копии в корневом `.eve/discovery/` и `.eve/compile/` остались от прогона на более старой версии Eve
(compile schema 39 против текущей 41), и ни `eve build`, ни `eve dev` их больше не обновляют: dev
пишет compiler artifacts в свою папку `.eve/dev-hosts/<uuid>/compiler/`. Сверять по корневым копиям
discovery нельзя.
Формулировки промптов тестами не проверяются: соответствующие тесты удалены сознательно, поэтому
изменения prompt-текста проверяются чтением диффа и живым чатом.
Production image собирается только из canonical repository state через CI/CD.
Не запускать ручной production build и не менять production database в рамках обычной задачи.

## Перед началом любой новой сессии

1. Прочитать этот файл.
2. Найти существующий модуль, repository и тест до создания нового файла.
3. Для Eve API открыть локальный guide и установленный `.d.ts`.
4. Не трогать память, deployment или persisted contract без явного scope задачи.
