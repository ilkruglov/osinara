# Memory System Upgrade

## Статус

Документ фиксирует отдельный будущий этап. Перечисленные ниже изменения не входят в recovery patch и
не должны внедряться частично без нового production-аудита, failing tests и явного решения владельца.

## Исходные данные

Production-аудит 14 августа 2026 года показал два независимых класса проблем:

- background memory review может остановить lane после неоднозначного завершения Eve session;
- semantic-only retrieval при пороге `0.78` возвращает тематически близкие, но сущностно неверные
  записи, например Orca для вопроса о репозитории Осинары.

Recovery lane, сохранение exact sources и private alert владельцу реализуются отдельно. Они не меняют
retrieval ranking, границы model context или retention policy.

## 7. Semantic Gating

### Проблема

Один глобальный cosine threshold недостаточен для коротких запросов о конкретной сущности, ссылке,
репозитории или навыке. Высокое тематическое сходство не доказывает совпадение Осинары и Orca либо
Ивы и Eve.

### Предлагаемое исследование

- выделить типизированные сигналы identity, URL, repository и skill до semantic ranking;
- требовать exact lexical/entity evidence для запросов с явным именем или владельцем сущности;
- разрешать semantic-only ветку для настоящих paraphrase-запросов без конфликтующего имени;
- калибровать пороги отдельно по типу запроса, не подменяя отсутствующие данные fallback-значением;
- включить `MEMORY_RETRIEVAL_V2_FUTURE_GATES` только после измерения recall/abstention на pinned E5.

### Критерии приёмки

- identity controls сохраняют recall@5 `1.0`;
- все V2 hard negatives возвращают пустой результат;
- существующие morphology, mixed-language и paraphrase gates не регрессируют;
- решение подтверждено production-like PostgreSQL/E5 eval, а не только unit fixtures.

## 8. Query Context And Reply Ancestry

### Проблема

Изолированный текст текущего сообщения может не содержать сущность, если пользователь отвечает
«а где его репозиторий?» на предыдущую реплику. Добавление всей истории увеличит шум и риск
межтематического совпадения.

### Предлагаемый контракт

- query builder принимает проверенный current timeline entry и bounded reply ancestry;
- ancestry следует только по durable `reply_to_sequence_id` в той же conversation/topic;
- authored agent output и user text остаются раздельными полями, а не склеиваются неразмеченной строкой;
- модель не выбирает conversation, topic, author или scope;
- retrieval audit сохраняет исходный query, использованные sequence IDs и причину расширения.

### Критерии приёмки

- pronoun/reply queries находят сущность из точного parent message;
- соседняя тема и сообщения без reply edge не попадают в query context;
- удалённый или недоступный parent приводит к явному отсутствию контекста без invented fallback.

## 9. History Bounds

### Проблема

Агент не сообщает, какой диапазон Telegram timeline реально доступен. Пользователь может ожидать поиск
по сообщениям, которые уже вышли из retained journal и никогда не стали long-term memory.

### Предлагаемый контракт

- repository возвращает oldest/newest retained sequence и timestamp для текущей lane;
- model context явно разделяет long-term memory results и bounded recent history;
- ответ сообщает об ограничении, если запрос требует период вне доказанного диапазона;
- отсутствие диапазона является диагностируемой ошибкой состояния, а не нулевой датой или «всей историей».

### Критерии приёмки

- агент не утверждает, что проверил удалённую историю;
- topic lanes показывают собственные границы;
- pruning и retrieval используют одну проверяемую трактовку retained range.

## 10. Retention And Archive Policy

### Проблема

Текущий лимит в 1000 timeline messages ограничивает recovery и исторический поиск. Простое увеличение
лимита переносит проблему и бесконтрольно увеличивает PostgreSQL storage.

### Варианты для решения

1. Увеличить per-conversation retention с измеряемым storage budget и pruning watermark.
2. Ввести холодный immutable archive, недоступный модели напрямую и читаемый только scoped repository.
3. Сохранять только durable review source sets сверх обычного retention до terminal/operator resolution.

### Обязательные ограничения

- family/group isolation сохраняется физическими predicates и foreign keys;
- archive не становится вторым memory store и не участвует в retrieval без явного запроса;
- удаление trust zone каскадно удаляет либо криптографически уничтожает архив этой области;
- стоимость, срок хранения, экспорт и окончательное удаление должны быть определены до migration;
- production backfill запрещён без dry-run отчёта по объёму и проверенного rollback plan.
