# Production-аудит Osinara за 2026-08-30

## Итог

Production в целом стабилен: контейнеры работают без рестартов и OOM, health endpoint сообщает
`ready`, Telegram ingress не содержит активных или зависших updates.

Остаётся одна известная проблема качества: automatic retrieval технически работает, но добавляет
нерелевантную память на нейтральных запросах.

Аудит выполнялся в read-only режиме. Рестарты, миграции, изменения конфигурации и записи в production
PostgreSQL не выполнялись. Для проверки retrieval использовались только `SELECT` и read-only E5
inference. Содержимое пользовательских сообщений и памяти в отчёт не включено.

## Состояние production

- Развёрнут release `v0.17.1`, revision `04552768f14a91f06817ae835e28fbbaa27d5078`.
- Все контейнеры Osinara работают и проходят health checks.
- За три дня у контейнеров `RestartCount=0`, `OOMKilled=false`.
- `/eve/v1/health` возвращает `ready`.
- Диск заполнен на 66%, свободно около 14 ГБ.
- Доступно около 1.6 ГБ RAM; OOM не зафиксирован.
- Docker хранит около 9.969 ГБ удаляемых образов.
- Telegram ingress: 16 811 completed updates, активных и зависших updates нет.

## 1. Automatic retrieval работает, но возвращает semantic noise

### Подтверждённый рабочий путь

Перед model call dynamic instructions в `agent/instructions/retrieved-memory.ts:30` вызывают
`resolveMemoryBlock`. Production-путь успешно выполняет:

1. извлечение текста текущего Telegram-сообщения;
2. построение локального multilingual E5 embedding;
3. scoped PostgreSQL retrieval с simple FTS, русской морфологией и pgvector;
4. conflict closure;
5. активацию memory threads;
6. формирование untrusted JSON prompt block.

Положительный production-контроль по трём существующим записям нашёл каждую исходную запись на первом
месте с semantic similarity `0.95-0.98`.

### Проблема качества

Текущий semantic threshold равен `0.78` в `agent/lib/memory-config.ts:67`. Нейтральные и заведомо
посторонние запросы дали следующие результаты:

| Контрольный запрос | Результатов | Semantic score | Lexical hits |
| --- | ---: | --- | ---: |
| `Привет` | 1 | `0.7845` | 0 |
| `Спасибо` | 4 | `0.7868-0.7974` | 0 |
| `Хорошо` | 5 | `0.7826-0.7863` | 0 |
| `Ок` | 0 | - | 0 |
| `Продолжай` | 2 | `0.7811-0.7865` | 0 |
| посторонняя предметная тема | 1 | `0.7954` | 0 |

Шесть последних production-сообщений также получали от 2 до 7 результатов, преимущественно только
через semantic branch. Размер добавленного memory prompt составлял примерно 2.9-6.4 тысячи символов.

Следовательно, память действительно вставляется перед ответом, но короткие и нерелевантные сообщения
часто получают лишний контекст.

### Почему нельзя просто поднять threshold

В versioned V1 eval минимальный score обязательного semantic paraphrase равен `0.79002`, а наблюдаемые
production false positives достигают `0.7974`. Один scalar threshold не разделяет эти классы без
потери полезного recall.

Проблема уже зафиксирована в legacy V2 benchmark:

- `identityControlRecallAt5 = 1`;
- `hardNegativeEmptyRate = 0`;
- будущий semantic gating явно оставлен за пределами прежнего release.

Файл `agent/lib/memory-retrieval-eval-fixture.v2.ts:81` сохраняет плохой baseline как ожидаемое
поведение, поэтому текущие тесты не являются release gate против semantic noise.

### Требуемое исправление

1. Создать новый versioned eval с generic short queries и identity hard negatives.
2. Реализовать semantic gating отдельно от простого повышения threshold. Он должен отбрасывать
   нейтральные короткие запросы и identity-conflicting candidates, сохраняя cross-language и
   paraphrase recall.
3. Перевести `hardNegativeEmptyRate` из измеряемого плохого baseline в обязательный release gate.
4. Добавить privacy-safe retrieval observability без текстов и внутренних ID:
   - количество результатов;
   - число semantic-only и lexical candidates;
   - диапазон scores;
   - conflict и thread counts;
   - размер добавленного prompt;
   - длительность retrieval;
   - код ошибки при fail-closed результате.

## 2. Состояние данных памяти

- Всего 354 memory items, из них 353 active.
- 352 active items имеют indexed embeddings.
- Один active item имеет failed embedding job с 2026-08-02.
- 516 embedding chunks; indexed items без chunks отсутствуют.
- 25 active memory threads, title embeddings присутствуют у всех.
- Personal: 64 active items, из них 50 `legacy_unresolved` и 14 `evidenced`.
- 20 personal legacy items длиннее 1000 символов.
- Средняя длина personal item - 913 символов, максимальная - 3878.
- Group: 277 active items, преимущественно evidenced; средняя длина - 217 символов.

`legacy_unresolved` records участвуют в automatic retrieval. Среди них присутствуют длинные
процедурные записи вместо кратких устойчивых фактов, что усиливает semantic noise.

Автоматически скрывать или удалять эти 50 записей нельзя: это persisted пользовательские данные и
такое изменение может убрать ранее доступную память. Их очистка требует отдельного согласованного
этапа с сохранением возможности просмотра и восстановления.

Failed embedding job следует восстановить отдельной точной операцией после проверки embedding
service. Автоматический бесконечный retry добавлять нельзя.

## Рекомендуемый порядок работ

1. Добавить retrieval observability.
2. Расширить versioned eval production-derived negative controls.
3. Реализовать semantic gating без потери paraphrase и cross-language recall.
4. Провести отдельный аудит 50 `legacy_unresolved` personal records.
5. Точно восстановить один failed embedding job.

Такой порядок сначала добавляет измеримость и release gate, а затем меняет качество отбора и
persisted legacy data в отдельном контролируемом scope.

## Что не проверено

- Фактический model-visible prompt конкретного уже завершённого production turn нельзя восстановить:
  retrieval telemetry сейчас отсутствует.
- Batch от 2026-08-23 не признан ошибочным автоматически, потому что его source-binding log уже вне
  доступного окна наблюдения.
- Обновлённый egress image ещё не развёрнут в production; после release не проверены реальный Google
  Workspace вызов и снижение прежних CONNECT timeout для долгоживущих browser-соединений.
- Исправления оставшихся retrieval и legacy-memory пунктов не реализовывались.
