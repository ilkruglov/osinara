# Native PostgreSQL Workflow Cutover

## Статус

План реализации. Production продолжает работать на Eve `0.32.0` и `world-local`, пока новый runtime
не пройдёт полный migration и stress gate. Лимит ротации в 50 завершённых turns остаётся временным
circuit breaker и удаляется только после доказанного bounded replay.

## Причина изменения

Production incident подтвердил, что проблема находится не в model context. Одна Eve session после
118 turns накопила 58 637 durable stream chunks, 1 195 workflow events и 239 steps. Её данные заняли
около 372 МБ, а deterministic replay превысил жёсткий лимит Workflow SDK в 240 секунд до нового
model call.

Upstream Eve issue [#1441](https://github.com/vercel/eve/issues/1441) подтверждает квадратичную
запись cumulative `messageSoFar` и `reasoningSoFar`. Официального Eve-параметра, отключающего эти
snapshots, сейчас нет. Поэтому этот план не утверждает, что PostgreSQL уменьшит семантический объём
stream. Цель PostgreSQL world - убрать file-per-event I/O, directory scans и local queue bottlenecks,
после чего измерить реальный предел без изменения Eve protocol.

## Целевая архитектура

- Использовать последнюю стабильную Eve после отдельного аудита миграции с `0.32.0`.
- Использовать официальный `@workflow/world-postgres`, закреплённый на совместимой с Eve линии
  Workflow protocol.
- Выбирать world только через публичный `defineAgent({ experimental.workflow.world })`.
- Хранить Workflow state в отдельной PostgreSQL database и под отдельной ролью с минимальными
  правами; application database не должна содержать Workflow tables.
- Передавать обязательный `WORKFLOW_POSTGRES_URL` только migrate и agent containers.
- Создавать и проверять Workflow schema только через `npm run migrate` внутри migrate container.
- Оставить Eve compaction ответственным за model history; application memory и Telegram timeline
  не заменяют нативный transcript внутри активной Eve session.
- Не добавлять patch, который меняет Eve stream protocol, cumulative event payloads или Workflow
  replay semantics.
- Не выполнять dual-write между `world-local` и PostgreSQL world.

## Конфигурация

Обязательные environment-specific значения:

- `WORKFLOW_POSTGRES_URL` - credentialed URL отдельной Workflow database.

Версионируемые runtime constants задаются в Compose/config, а не в `.env`:

- `WORKFLOW_REPLAY_TIMEOUT_MS` - временный bounded escape hatch в документированном диапазоне;
- `WORKFLOW_COMPRESSION_CODEC` - документированный write codec после проверки фактического storage;
- stream batching параметры - только после benchmark, поскольку batching запросов не гарантирует
  уменьшение количества logical chunks.

Ни один параметр не получает fallback. Отсутствующий Workflow URL или несовместимая protocol
version должны останавливать migration и startup с диагностируемым стабильным error code.

## Версии и patch audit

1. Зафиксировать текущую latest stable Eve и прочитать её changelog от `0.32.0`.
2. Проверить публичные types и runtime source новой версии.
3. Определить точную совместимую версию `@workflow/world-postgres` по protocol metadata, а не по npm
   `latest` tag.
4. Для каждого изменения в `scripts/apply-eve-patches.ts` найти официальный эквивалент.
5. Удалить заменённые upstream части patch и соответствующие regression tests.
6. Не переносить строковые patches на новый minified artifact без повторного аудита.
7. Чистый `npm ci` обязан применяться без ручного изменения `node_modules`.

## Database lifecycle

### Bootstrap

1. Installer создаёт отдельную Workflow role, database и credential.
2. `npm run migrate` применяет application migrations и idempotent Workflow bootstrap.
3. Migration проверяет ожидаемые Workflow tables, protocol compatibility и права роли.
4. Agent стартует только после успешного migrate health boundary.

### Retention

Eve session timeout и context compaction не удаляют stored Workflow data. До cutover необходимо:

1. Найти поддерживаемую package surface для terminal run deletion.
2. Если package экспортирует только schema, реализовать application-owned deletion через
   документированные tables и проверенные cascade contracts, не через guessed SQL.
3. Никогда не удалять active, waiting, HITL-pending или OAuth-pending run.
4. Сохранять retention hold для memory review и других подтверждённых application dependencies.
5. Покрыть physical deletion integration test на реальном PostgreSQL world.

## Cutover

Filesystem runs не переносятся в PostgreSQL: официальный migration path отсутствует.

1. Создать проверенный backup application database, Workflow volume и deployment manifests.
2. Остановить Telegram ingress worker перед agent, сохранив durable incoming updates в PostgreSQL.
3. Дождаться terminal boundary всех активных turns; неоднозначно начатые side effects не повторять.
4. Пометить активные application sessions на rotation, не удаляя memory, timeline или workspace.
5. Выполнить migration внутри migrate container.
6. Запустить agent с PostgreSQL world и затем ingress worker.
7. Убедиться, что первые сообщения создают новые Eve session IDs и сохраняют прежние application
   scopes, thread IDs, memory и Telegram timeline.
8. Оставить старый local Workflow volume read-only на rollback window; не монтировать его новому
   agent.

## Rollback

Rollback не может прозрачно продолжить PostgreSQL session в `world-local`.

1. Остановить ingress worker и agent.
2. Вернуть предыдущий immutable release и прежний Workflow volume.
3. Пометить application sessions, уже привязанные к PostgreSQL Eve IDs, на новую rotation.
4. Не повторять updates с установленным `dispatch_started_at`.
5. Запустить agent, затем worker, и проверить terminal queue state.
6. PostgreSQL Workflow database сохранить для forensic analysis; не удалять при rollback.

## TDD и проверки

### Contract tests

- Agent config выбирает только pinned PostgreSQL world package.
- Production Compose требует `WORKFLOW_POSTGRES_URL` у migrate и agent и не передаёт credential
  другим services.
- Installer создаёт отдельный credential без вывода секрета в logs.
- Migration bootstrap идемпотентен и fail-closed при несовместимой schema/protocol version.
- Standalone fresh install и production update используют одинаковую world architecture.
- Local Workflow volume больше не монтируется в agent после cutover.
- Retention удаляет только доказанно terminal runs после application retention boundary.

### Integration tests

- PostgreSQL world переживает stop/start agent посреди безопасного durable turn.
- HITL resume продолжает точную session после restart.
- Telegram FIFO не освобождается до `session.waiting`, `session.completed` или `session.failed`.
- Failed dispatch не оставляет бесконечный lease и не блокирует другие queues.
- Backup и rollback возвращают обслуживаемый runtime без повторного model/tool side effect.

### Stress gate

Использовать deterministic test model без внешней оплаты и прогнать не менее 300 последовательных
turns в одной session с reasoning, text и tool boundaries. Gate считается пройденным только если:

- нет `REPLAY_TIMEOUT`, `MAX_EVENTS_EXCEEDED` и stuck workflow delivery;
- каждый turn достигает terminal boundary;
- replay-to-first-step latency остаётся bounded и не показывает монотонного коллапса;
- Workflow table bytes, rows и chunks измерены отдельно от model context;
- restart в контрольных точках не создаёт duplicate tool side effects;
- retained terminal runs физически удаляются после test retention boundary.

Только после успешного stress gate удаляется `SESSION_MAX_COMPLETED_TURNS = 50`. Если gate не
проходит, native PostgreSQL world считается недостаточным, circuit breaker остаётся, а дальнейшее
решение ждёт upstream Eve fix вместо скрытого protocol patch.

## Production verification

- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- Проверка Eve discovery и compiled manifests.
- Полный Docker Compose test gate с реальной PostgreSQL Workflow database.
- Проверка migration state и role grants внутри containers.
- Controlled production backup, cutover и rollback rehearsal до promotion.
- После promotion: health, queue state, workflow tables, Telegram private/group turns, tool call,
  HITL, restart resume, schedules и retention sweep.

## Критерий завершения

Работа завершена, когда production использует официальный PostgreSQL world, старый filesystem world
не участвует в runtime, stress gate доказал bounded 300+ turn replay, terminal retention работает,
rollback проверен, а временный лимит 50 turns удалён отдельным доказанным изменением.
