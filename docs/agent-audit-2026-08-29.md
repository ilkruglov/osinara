# Аудит агента Osinara

Дата: 29 августа 2026 года.

Аудит выполнен в режиме read-only. Исходный код не изменялся; существующие изменения в рабочем дереве оставлены нетронутыми.

## Findings

### 1. Высокий: Telegram ingress глобально сериализует независимые чаты

Один `activeDrain` обслуживает весь процесс и последовательно ждёт session boundary:

- `agent/lib/telegram-durable-ingress.ts:189`;
- `agent/lib/telegram-durable-ingress.ts:217`;
- `agent/lib/telegram-durable-ingress.ts:327`.

При этом SQL уже обеспечивает FIFO только внутри конкретной очереди и допускает независимый progress:

- `agent/lib/telegram-ingress-repository.ts:245`;
- `agent/lib/telegram-ingress-repository.integration.test.ts:261`.

Медленный turn одного чата блокирует все остальные чаты и темы. Exactly-once не нарушается, но возникает service-wide head-of-line blocking.

Рекомендация: использовать bounded worker pool с сохранением per-queue FIFO. Полная замена Telegram transport не требуется.

### 2. Высокий: ошибка timeline после доставки бросает оставшуюся пачку напоминаний

До 25 jobs арендуются заранее, но обрабатываются последовательно:

- `agent/lib/reminders/reminder-dispatcher.ts:45`.

Групповая timeline-запись выполняется после успешного `complete` и вне `try/catch`:

- `agent/lib/reminders/reminder-dispatcher.ts:78`.

При её ошибке оставшиеся jobs остаются leased. После трёх таких циклов они переходят в `AGENT_REMINDER_DELIVERY_ATTEMPTS_EXHAUSTED`, даже если Telegram для них ни разу не вызывался:

- `agent/lib/reminders/reminder-dispatch-repository.ts:116`.

Рекомендация: изолировать projection failure на уровне одного job и предусмотреть repair из уже сохранённого proactive receipt.

### 3. Средний: lease напоминаний короче худшего времени batch

Budget составляет `25 × 15 секунд = 375 секунд`, а lease равен 300 секундам:

- `agent/lib/reminders/reminder-config.ts:11`;
- `agent/config.ts:37`.

`markDispatchStarted` и `complete` не проверяют `lease_expires_at`:

- `agent/lib/reminders/reminder-dispatch-repository.ts:240`;
- `agent/lib/reminders/reminder-dispatch-repository.ts:267`.

Параллельный minute schedule может уже пометить job ambiguous, пока старый worker отправляет его в Telegram. Основной риск не в автоматическом дубле, а в доставленном сообщении без durable receipt и с ложным terminal status.

Рекомендация: claim ближе к отправке, ограничить одновременно арендованный batch и проверять актуальность lease перед side effect.

### 4. Средний: authorization напоминания устаревает внутри batch

Membership и trust zone проверяются только во время `claimDue`:

- `agent/lib/reminders/reminder-dispatch-repository.ts:135`.

Непосредственно перед Telegram проверяется только lease token:

- `agent/lib/reminders/reminder-dispatch-repository.ts:240`.

Уже исключённый участник может получить ранее claimed personal reminder.

Рекомендация: включить текущую membership и destination authorization в финальный marker query перед отправкой.

### 5. Средний, операционный: документация противоречит runtime

Фактически используется Eve `0.40.0`:

- `package.json:36`;
- `scripts/apply-eve-patches.ts:18`.

Но следующие документы и комментарии всё ещё требуют или описывают семантику `0.32.0`:

- `AGENTS.md:5`;
- `AGENTS.md:15`;
- `CLAUDE.md:5`;
- `docs/production-deployment.md:74`;
- `agent/lib/tool-policy/mode-tool-surface.ts:377`.

Production использует PostgreSQL Workflow, а не описанный local-world volume:

- `compose.production.yaml:108`.

Несоответствие создаёт риск неправильных Eve-изменений и ошибок в backup/restore процедурах.

## Неподтверждённые риски

- Лексикографическое сравнение `eve_session_id` сейчас корректно: установленный Workflow генерирует `wrun_` с monotonic ULID.
- Автоматические дубли напоминаний после ambiguous delivery не найдены: durable marker запрещает retry.
- Обход external auth, filesystem confinement или restricted sandbox не найден.
- Runner API не имеет service token, но доступен только через `sandbox-control`; реалистичного пути из model-controlled sandbox не найдено.
- `memory-extraction-worker` является документированной controller-совместимостью. Удалять его без отдельной двухфазной миграции нельзя.

## Legacy cleanup

- `agent/lib/tool-policy/trusted-worker-file-tools.ts` не импортируется production-кодом и выглядит как оставшийся путь старого worker.
- `requireRuntimeEnvironment` используется только тестами; production отдельно проверяет переменные в `scripts/docker-entrypoint.sh`.
- Масштабное переписывание не требуется. Нужны локальные исправления ingress concurrency, reminder dispatch и документации.

## Проверка

- `npm run build`: успешно.
- Полный Docker Compose gate, включая миграции, typecheck, integration-тесты и Eve build: успешно.
- Test files: `332 passed`, `2 skipped`.
- Tests: `1933 passed`, `3 skipped`.
- `git diff --check`: успешно.
- Независимое read-only ревью подтвердило основные выводы.
