# Osinara Agent Guide

## Что это за проект

Osinara — семейный Telegram-агент на TypeScript, Eve `0.40.0`, PostgreSQL и Groq.
Основная модель по умолчанию — DeepSeek V4 Flash через родной Responses API
(`api.deepseek.com/responses`, транспорт `deepseek-responses`, `agent/lib/deepseek/`): запрос
приводится к документированной таблице совместимости DeepSeek (неподдерживаемые поля убираются,
`reasoning.effort` none/low/high/max берётся из конфига и реально меняет глубину рассуждений),
документированные HTTP-статусы становятся стабильными кодами, usage читает `cached_tokens` и
`reasoning_tokens`. Серверный `web_search` DeepSeek Eve выставляет в личном и семейном чатах; во
внешних группах и в тихом review он перекрыт отказом. Chat Completions и Anthropic-совместимый
транспорты DeepSeek остаются допустимыми в схеме. У vision-модели есть своё поле
`reasoningEffort`: на `deepseek-v4-flash-vision-exp` effort max давал 28k токенов рассуждения и четыре
минуты на одно фото, поэтому основная модель может идти на `max`, а vision остаётся на `high`.
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
Тихая проверка памяти (`agent/lib/memory-review/`) запускается минутным диспетчером для каждой lane
личного чата и группы: батч из 1–50 непроверенных сообщений материализуется при десяти накопленных
сообщениях, после десяти минут тишины при хотя бы пяти или после шести часов тишины при любом
числе; группа подшивает хвост к обычному адресованному ходу только от восьми сообщений, короче
ждёт idle. Фоновый батч получает до 20 уже проверенных сообщений перед ним в блоке
`<preceding_context>` только для понимания; завершение батча пишет `AGENT_MEMORY_REVIEW_RESULT`
(размер, длительность, число записей), а сборка памяти на ход пишет `AGENT_MEMORY_CONTEXT`
(тайминги retrieval и profile view). Личная lane создаётся лениво с курсора 0, поэтому история личного чата
проверяется один раз при первом запуске. Решение остаётся у root-агента через `remember`.
Профильные записи имеют необязательный слот `attribute`; новая запись того же субъекта и слота
помечает прежнюю `superseded` (`memory-slot-supersede.ts`), а тихий review видит уже сохранённые
записи разговора в блоке `<existing_memory>`, чтобы версионировать слот, а не дублировать.
События (`kind: episode`) несут `occurred_at`; retrieval учитывает дату события в recency-boost,
а `search_memories` принимает окно `occurredAfter`/`occurredBefore` для вопросов о периоде.
Автоподборка памяти и карточка профиля ведут учёт показов (`memory-context-exposure-repository.ts`,
миграция 088): запись, показанная в последние 10 ходов той же application-сессии, в автоподборку не
попадает (поиск инструментом её не скрывает), карточка текущего автора возвращается через 20 ходов
или когда автор стал субъектом reply/упоминания. Без этого три записи группы крутились по 50 раз в
сутки.

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
12. Следующий item того же чата освобождается только после достижения session boundary; разные
    чаты идут параллельно, до трёх drain-циклов.

Дедупликация основана на Telegram `update_id`.
Перед Groq и Eve dispatch сохраняются durable start markers.
После неоднозначного crash автоматический повтор запрещён, чтобы не удвоить оплату или side effect.

## Живая подача сообщений

Один ответ модели может стать несколькими Telegram-сообщениями. Границу выбирает модель строкой
`<telegram-split>`; приложение не проверяет длину, число абзацев и разметку частей. Единственный
предел в `agent/lib/telegram-authored-split.ts` ограничивает число сообщений с паузой: всё сверх
потолка приклеивается к последнему сообщению, текст не теряется. Директива является транспортным
синтаксисом и никогда не доходит до человека: отдельной строкой она делит ответ, в любом другом
месте вырезается, а внутри fenced или indented code остаётся содержимым ответа. Reply-цитата стоит
только на первом сообщении; перед каждым следующим канал отправляет typing action и ждёт паузу из
`telegram-aside-pacing.ts`, привязанную к времени жизни индикатора Telegram. Правило длинного
ответа применяется к каждому сообщению отдельно. В scheduled runs дробление вырезается из текста.

Текст, написанный моделью до вызова инструмента, теперь доставляется как progress notice
(`agent/lib/telegram-progress-notice.ts`). Заявка в `telegram_progress_notices` по
`(eve session, turn, step index)` делается до отправки, поэтому повтор хода не дублирует отбивку;
сбой отправки логируется и не роняет turn, потому что ответ ещё готовится. Notices не попадают в
timeline и не выдаются в scheduled runs. Текст придерживается (`telegram-progress-deferral.ts`), пока
`actions.requested` не назовёт инструменты шага: тихие служебные (`remember`, поиск и чтение памяти,
`manage_skill`…) отбивку не выпускают, следующий видимый текст её отменяет, завершение хода с
придержанным текстом отправляет его как ответ; долгий инструмент выпускает отбивку сразу. Иначе
ответ, написанный рядом с `remember`, уходил дважды. Когда отбивка ушла, `wrapModelFacingTool`
добавляет к результату каждого прикладного инструмента этого хода поле `already_sent_to_user`:
без него модель после `generate_image` писала финал заново по всем темам, и текст приходил дважды.

Набор допустимых реакций задаёт Telegram, а не приложение. Канал раз в сутки на чат обновляет
`available_reactions` через `getChat` и сохраняет ответ в `telegram_chat_reaction_policies`;
отсутствующее поле документировано как разрешение любых эмодзи. Раздел про реакции живёт в блоке
режима, а не в постоянном ядре: разрешено всё, сужённый список, реакции выключены или политика
неизвестна. В последних двух случаях раздел отсутствует и агент отвечает текстом.

## Авторизация и scopes

`private` требует подтверждённую семейную identity.
Личный чат получает scopes `personal` и `family`.
`family_private` принимает только активного участника той же семьи и получает `family`.
`external` получает только собственный `group` scope.
Внешняя группа никогда не получает личную или семейную память и подключения.

Owner-only операции разрешены только в личном Telegram-чате владельца.
После HITL side-effect executor должен повторно проверить текущую owner-role в БД.
Окно подтверждения собирает приложение: заголовок и факты выводятся из того же input, который уйдёт на исполнение, поэтому текст не может описывать одно действие, а выполнять другое. Запрос подтверждения не ждёт вечно: неотвеченные tool-approval и вопрос отменяются через пять минут, tool не исполняется, turn продолжается, а пользователь получает предупреждение и не получает повторный запрос без явной просьбы. Framework `session-limit` и OAuth в это окно не входят.
Несколько подтверждений одного шага (параллельные вызовы gated-инструментов) показываются одним
сообщением с кнопками «подтвердить все / отменить все»: строки в `telegram_hitl_approvals` по одной
на request_id при общем `telegram_message_id` (миграция 089), `claimCallback` гасит их все, а
патч Eve отдаёт `inputResponses` хука одной доставкой; таймаут тоже отменяет все просроченные
запросы сессии одним `respond`. Причина: Eve 0.40.0 сводит ответы батча только внутри одной
доставки, ответы по одному вытесняют друг друга из отложенного ввода, и припаркованный ход
не возобновляется до следующего постороннего сообщения. Ingress после `approval.settled`
проверяет в `telegram_hitl_approvals`, остались ли у сессии неотвеченные запросы: остались,
значит ход не возобновится и доставка завершена (`AGENT_TELEGRAM_APPROVAL_BATCH_PENDING`).
Drain-циклов до трёх одновременно (`maxConcurrentDrains`): `claimNext` держит FIFO внутри
чата или топика сам, а один длинный ход (effort max, минуты) раньше держал все чаты и кнопки.
Придержанный pre-tool текст сбрасывается на `input.requested`: окно подтверждения и есть ответ
шага, иначе текст уходил после кнопок и повторял ответ возобновлённого хода.
Изменение типа группы пересоздаёт trust zone и удаляет данные старой области.
Сообщения других ботов (Bot API 10.2, июль 2026: приходят, если у бота включён Bot-to-Bot
Communication Mode в @BotFather, он администратор группы и приватность выключена) — участник
ленты `telegram_bot` (миграция 090, патч Eve снимает отсечку `from.isBot`). Бот никогда не несёт
identity и прав: в семейной группе он только пишется в журнал и виден в таймлайне, во внешней
может начать ход как `external`, но не отвечает на подтверждения (`telegram-reply-authorization.ts`)
Бот хранит свой Telegram user id в журнале и становится участником разговора без связи с
аккаунтом; его сообщения идут в тихую проверку памяти и годятся как доказательство записи.
Ограничителя обмена между ботами нет по решению владельца; петлю двух ботов останавливают люди.
Rich-сообщения (Bot API 10.1) приходят в `message.rich_message.blocks`, а `text` пуст или
неполон; Eve читает только `text`, поэтому ingress разворачивает блоки в текст
(`telegram-rich-message.ts`: абзацы, details с summary, цитаты, списки, таблицы, подписи) до
адресации, журнала и доставки. Без этого свёрнутый «Полный ответ» другого бота приходил пустым.
Ответ человека на сообщение другого бота (имя бота есть и не наше, чат не личный) идёт как обычное
сообщение (`telegram-reply-authorization.ts`): иначе нативный Eve отправлял его как текстовый
ответ на несуществующий HITL-вопрос, ход не начинался, границы не было, drain чата зависал.

Весь прикладной tool surface выдаётся per-mode через step-scoped Eve `defineDynamic` в `agent/tools/capabilities.ts`.
Статических дескрипторов у приложения нет: инструмент, недоступный текущему режиму, не имеет дескриптора вообще, а не заменяется заглушкой.
Реализации инструментов лежат в `agent/lib/tools/`; в `agent/tools/` остаётся только dynamic resolver, иначе дескриптор станет виден во всех режимах.
Матрица режимов и внешний allowlist собираются в `agent/lib/tool-policy/mode-tool-surface.ts`; сбой резолвера или недоказанный режим означает отсутствие прикладных инструментов.
Нативные контракты `glob`, `grep`, `read_file` и `write_file` во внешней группе перекрываются same-name dynamic wrappers: каждый execute повторно проверяет актуальную external registration, принимает только канонический путь внутри точного `/workspace/group` и запрещает symlink-компоненты до вызова Eve default executor. В trusted private/family режимах wrappers не выдаются, поэтому исходные Eve built-ins сохраняют personal/family mounts и tools environment.
Eve `0.40.0` не умеет скрывать собственные built-ins per-session, поэтому `bash`, `todo` и `ask_question` во внешней группе перекрываются явным отказом. `web_fetch` выдаётся только через локальный controlled wrapper с execution-time проверкой; provider-native `web_search` не имеет local execution hook, поэтому его grant освобождает descriptor Eve только на шагах, где live policy содержит право (граница отзыва — следующий model step), а в scheduled runs он остаётся запрещён. Во внешней группе `load_skill` загружает только capability-coupled `imagegen` после live-проверки grant `generate_image`.
`generate_image` доступен при provider `codex-subscription` (GPT-Image-2) либо при заданных `CLOUDFLARE_ACCOUNT_ID`+`CLOUDFLARE_AI_TOKEN` и/или `NEURALDEEP_IMAGE_API_KEY` (Flux: цепочка Cloudflare klein-4b → NeuralDeep в `agent/lib/image-generation/flux-image-clients.ts`; любой сбой провайдера, включая его фильтр контента, переводит на следующего; schnell не используется, он не принимает размеры; формат файла по magic-байтам, ledger хранит путь без расширения). В codex-режиме: при любом другом provider он не имеет дескриптора ни в одном режиме и отсутствует в owner-facing grant contract, поэтому включить его нельзя. В private/family он доступен интерактивному root-agent; внешней группе владелец выдаёт capability через `manage_telegram_group.update_policy` из личного чата с HITL и повторной owner-role проверкой. Grant одновременно открывает dynamic skill `imagegen`; execution повторно читает live group policy. Subagents не получают ни tool, ни skill; trusted scheduled-ходы получают оба, внешние scheduled нет. Перед единственным вызовом `gpt-image-2` создаётся durable operation ledger; transport, 5xx и повреждённый success остаются terminal ambiguous без автоматического retry. Подтверждённый WebP сохраняется в authorized workspace и отправляется через exact-once `send_workspace_file`. CLIProxy запускается с `disable-image-generation: chat`, поэтому его скрытый provider tool не обходит application capability surface. Grant surface собирается в `agent/lib/tool-policy/grantable-group-capabilities.ts`: `manage_telegram_group` и registration принимают только capability, которую активный provider реально обслуживает, а grant, сохранённый под прежним provider, остаётся parseable, показывается в status как `unavailableConfiguredTools` и не выдаёт ни tool, ни skill.
Eve `0.40.0` materializes dynamic skill packages и supporting files в sandbox. Стабильные trusted Google Workspace skills выдаются на `session.started`, чтобы не загружать 19 пакетов перед каждым ходом, и только при заданных `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` (`GOOGLE_WORKSPACE_AVAILABLE`, тот же gate прячет три Google-инструмента); внешний capability-coupled `imagegen` остаётся на `turn.started`, поскольку grant может измениться между репликами. Trusted HOME хранится в persistent tools volume, поэтому `agent/sandbox.ts` на session lifecycle удаляет только точный legacy package path `.agents/skills/pohuy`; не расширять этот cleanup на соседние skills.
Авторские навыки (`agent/lib/authored-skills/`, миграция 086): Мия пишет себе навыки из доступных
инструментов, одна библиотека на семью. `manage_skill` (list, read, publish, rollback, retire,
record_outcome) выдаётся только владельцу в личном чате и семейной группе, не в scheduled, не
subagent, не во внешней группе; publish, rollback и retire идут через HITL с повторной проверкой
роли, `operationKey` = call id делает повтор безопасным. Backend-рубрика
(`authored-skill-contract.ts`) проверяет структуру: разделы «Когда применять», «Шаги», «Проверка
результата», имена инструментов в шагах только из каталога режима и встроенных Eve, ссылки на
`references/*.md` совпадают с переданными файлами, навык с `generate_image` несёт хотя бы один
файл `references/*.md` с шаблоном промпта, нет блоков недоверенного контекста и строк,
похожих на ключи; смысл проверяет владелец, глядя на пробный прогон. Резолвер `agent/skills/authored.ts`
отдаёт активные навыки на `turn.started` (личный чат владельца, семейная группа и их scheduled-ходы),
поэтому навык доступен со следующего хода; Eve пишет пакеты в sandbox каждый ход, отсюда лимиты
(40 навыков, markdown 8000, до 4 файлов по 6000). Хук `agent/hooks/skill-signals.ts` пишет
`authored_skill_usage` по `load_skill` и после хода с 4+ вызовами инструментов (без служебных)
кладёт строку в `conversation_skill_hints`; сборка контекста следующего хода показывает её один
раз (TTL 24 ч), и только по ней Мия предлагает навык. Мета-навык `agent/skills/skill-authoring/`
задаёт процедуру и справочники под DeepSeek Flash и Flux.
Навыки-аналитики `agent/skills/auto-analyst/` (машины, автопром, тюнинг, рынок) и
`agent/skills/policy-finance-analyst/` (политика, санкции, макро, рынки, разбор чужой аналитики):
метод в SKILL.md плюс справочники; в доверенных чатах видны как статические навыки, во внешней
группе `load_skill` пускает их при живом гранте `web_search` (`knowledge-skills.ts`), блок прав
перечисляет их рядом с `imagegen`. Навык добавляет метод и знания, не права: позицию в споре
не занимает, действий за человека не выполняет. В trusted scheduled-ходах доступны
`generate_image` и skill `imagegen`; внешние scheduled-ходы их не получают.
Restricted group sandbox держит `$HOME` на Docker tmpfs. Docker `putArchive` не пишет надёжно прямо в mount target, поэтому runner file I/O загружает bytes во временный rootfs path и переносит их внутрь контейнера; не возвращать прямой archive write без реального tmpfs smoke.
Trusted sandbox подключён только к internal egress network и выходит наружу через `sandbox-egress-proxy`. Для Node CLI runtime задаёт `NODE_USE_ENV_PROXY=1`; официальный Russian Trusted Root CA закреплён в sandbox image и передаётся через `NODE_EXTRA_CA_CERTS`, чтобы T-Invest HTTPS проходил проверку без отключения TLS. Restricted group sandbox не получает эти переменные и остаётся без сети.
Нативный Eve `agent` используется для сложной работы только в trusted private/family режимах, где полезен свежий контекст. Во внешней группе same-name dynamic denial не позволяет запускать child и delegation prompt не выдаётся. Trusted child получает отдельные history и state и наследует проверенный auth, connections, skills, sandbox, workspace и trust-zone tools текущего parent turn, кроме root-owned `remember` и `generate_image`. В Eve `0.40.0` implicit `agent` доступен только root runtime node, поэтому child не может рекурсивно делегировать и удалённый `maxSubagentDepth` больше не нужен. Synthetic `session-limit` из Eve никогда не показывается во внешней группе: channel boundary завершает такой turn до parking, persistence и Telegram delivery.

## Структура проекта

`agent/agent.ts` — модель и compaction; root-only delegation задаётся нативной семантикой Eve.
`agent/instructions.md` — постоянное mode-agnostic ядро промта, не authorization layer.
`agent/instructions/` — три turn-scoped dynamic блока system-role; порядок задан именами файлов: режим, делегация, стиль. Все три стабильны в рамках чата, поэтому system-префикс и дескрипторы инструментов попадают в prompt cache провайдера. Извлечённая память и profile view не инструкция: `agent/lib/telegram-turn-memory-context.ts` собирает их в handler и отдаёт через `context` Telegram-доставки, Eve кладёт каждую строку отдельным user-сообщением перед текущим сообщением. Dynamic user-role инструкции для этого не подходят: Eve показывает их следующим turn.started-обработчикам как последнее сообщение пользователя. Subagent-ходы память не получают.
`agent/hooks/model-usage.ts` — лог `AGENT_MODEL_STEP` на каждый model step; провайдерский usage с cache hit/miss логируется транспортом как `AGENT_MODEL_USAGE`.
`agent/channels/telegram.ts` — Telegram channel, events и durable ingress hooks.
`agent/tools/capabilities.ts` — единственный discovered application tool и dynamic surface текущего режима.
`agent/lib/tools/` — реализации model-facing typed tools; имя берётся из имени файла.
`agent/lib/image-generation/` — provider gate, no-retry transport, durable ledger, skill и external presentation генерации изображений.
`agent/lib/prompt/` — фрагменты промта и композиция блоков по режимам.
`agent/skills/` — активные статические Eve skills, session resolver trusted Google Workspace packages и turn resolver capability-coupled `imagegen`.
`agent/lib/` — application logic, repositories, policies и colocated tests.
`agent/sandbox.ts` — явный backend `just-bash` без настроенных network commands.
`migrations/` и `scripts/` — schema, migration runner, bootstrap, Eve patch и workers.
`infra/nginx.conf` и `compose.yaml` — edge allowlist и Docker services.

Не размещать `*.test.ts` в `agent/tools/` или `agent/channels/`.
Eve discovery воспримет такой файл как production tool или channel.
Тесты model-facing модулей размещать рядом по смыслу в `agent/lib/`.

## Локальный патч Eve

Eve `0.40.0` не предоставляет все application seams для durable Telegram ingress и по умолчанию
повторяет некоторые model calls на уровне Eve. `scripts/apply-eve-patches.ts` добавляет
verified-update/drain hooks, возврат Session, application routing/HITL contracts, exact-once model
policy (единственный повтор пустого ответа модели оставлен: у него нет side effect, а без него
reasoning-only ответ паркует сессию), fail-closed `input.requested`, verified task-origin auth, ограничение root delegation,
пятиминутное ожидание health при холодном старте и выбор провайдерского backend `web_search` по
префиксу id динамической модели (иначе Eve берёт gateway Exa и OpenAI-клиент молча отбрасывает tool).
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
После tool/channel edits проверять `.eve/discovery/agent-discovery-manifest.json` и результат `eve build`.
`.eve/compile/compiled-agent-manifest.json` относится к Eve `0.22.5` и не является актуальным artifact.
Формулировки промптов тестами не проверяются: соответствующие тесты удалены сознательно, поэтому
изменения prompt-текста проверяются чтением диффа и живым чатом.
Production image собирается только из canonical repository state через CI/CD.
Не запускать ручной production build и не менять production database в рамках обычной задачи.

## Перед началом любой новой сессии

1. Прочитать этот файл.
2. Найти существующий модуль, repository и тест до создания нового файла.
3. Для Eve API открыть локальный guide и установленный `.d.ts`.
4. Не трогать память, deployment или persisted contract без явного scope задачи.
