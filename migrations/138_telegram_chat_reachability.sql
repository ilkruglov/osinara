-- Чаты, куда сообщения бота больше не доходят (24 октября 2026, перенос из Шуши). Заблокированный
-- бот, удалённый аккаунт, бот, убранный из группы, и чат, которого Telegram не знает, отвечают на
-- каждую отправку одним и тем же 403/400, а напоминания, агентные расписания, сводка и
-- предупреждения владельцу продолжали писать туда каждый раз. Отправка по инициативе бота теперь
-- пропускает отмеченный чат; ответ на сообщение или кнопку человека эту таблицу не читает
-- (`agent/lib/telegram-reachability/`).
--
-- Строку ставит классифицированный отказ доставки (`delivery`) или апдейт Telegram `my_chat_member`
-- (`membership_update`), снимает любое сообщение из чата (`inbound_message`) или более поздний
-- `my_chat_member`, вернувший бота. Апдейты членства могут прийти не по порядку по параллельным
-- соединениям вебхука, поэтому последний применённый хранится парой (`membership_changed_at`,
-- `membership_update_id`), и более старый апдейт или сообщение не новее его игнорируются.
-- `reachable_evidence_at` — когда приложение последний раз получило доказательство доступности
-- чата (сообщение, разблокировку, возврат в группу): 403 на отправку, начатую раньше этого
-- момента, устарел и ничего не отмечает, даже если строки у чата ещё не было.
-- (`reachable_evidence_telegram_at`, `reachable_evidence_update_id`) — дата Telegram этого
-- доказательства (`date` сообщения или `my_chat_member`) и его update_id: задержанный `kicked`/`left`,
-- обработанный после более нового доказательства, чат не глушит. Сравнение идёт парой: более поздняя
-- дата выигрывает, при равной решает update_id. Одного update_id мало: после недели без апдейтов
-- Telegram начинает нумерацию со случайного числа (Bot API, Update), и свежее удаление с меньшим id
-- игнорировалось бы навсегда (ревью Codex). Только id, причины и время; никакого содержимого.
CREATE TABLE telegram_chat_reachability (
  telegram_chat_id text PRIMARY KEY CHECK (char_length(telegram_chat_id) BETWEEN 1 AND 64),
  unreachable_reason text CHECK (unreachable_reason IN (
    'blocked', 'deactivated', 'kicked', 'not_found', 'not_member', 'not_started'
  )),
  unreachable_since timestamptz,
  source text NOT NULL CHECK (source IN ('delivery', 'membership_update', 'inbound_message')),
  membership_update_id bigint CHECK (membership_update_id >= 0),
  membership_changed_at timestamptz,
  reachable_evidence_at timestamptz,
  reachable_evidence_telegram_at timestamptz,
  reachable_evidence_update_id bigint CHECK (reachable_evidence_update_id >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_chat_reachability_reason_since CHECK (
    (unreachable_reason IS NULL) = (unreachable_since IS NULL)
  ),
  CONSTRAINT telegram_chat_reachability_membership_pair CHECK (
    (membership_update_id IS NULL) = (membership_changed_at IS NULL)
  ),
  CONSTRAINT telegram_chat_reachability_evidence_pair CHECK (
    (reachable_evidence_update_id IS NULL) = (reachable_evidence_at IS NULL)
    AND (reachable_evidence_telegram_at IS NULL) = (reachable_evidence_at IS NULL)
  )
);
