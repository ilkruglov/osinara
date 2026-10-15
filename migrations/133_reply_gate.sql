-- Теневая оценка уместности ответа во внешней группе (ворота ответа). В этом релизе ворота
-- ничего не блокируют: ответ уже доставлен, оценка пишется рядом с ходом, чтобы откалибровать
-- порог по разметке владельца до включения. Оценку даёт типизированная модель решений (Jev):
-- регистр ответа, вероятности провала критериев и «стоит ли отправлять» по шкале уровней.
-- Текст сообщений людей сюда не попадает: только числа, коды и счётчики.
ALTER TABLE turn_evaluations
  -- Как Мия ответила на самом деле: текстом, реакцией, молчанием (директива) или реакцией,
  -- которую Telegram отклонил (человек ничего не получил).
  ADD COLUMN response_kind text CHECK (response_kind IN ('text', 'reaction', 'silent', 'reaction_failed')),
  -- Чем ход был запущен: reply на сообщение Мии или обращение по имени/@упоминанию.
  ADD COLUMN trigger_kind text CHECK (trigger_kind IN ('reply_to_mia', 'addressed')),
  -- Сколько ответов Мии в цепочке reply, которая привела к этому сообщению.
  ADD COLUMN reply_chain_depth integer CHECK (reply_chain_depth >= 0),
  -- Сколько последних ответов Мии подряд были этому же автору (включая текущий ход не считая).
  ADD COLUMN same_author_run integer CHECK (same_author_run >= 0),
  -- Итог обращения к воротам: scored (оценка получена), unavailable (сервис не ответил),
  -- skipped (ворота не настроены или ответ не текст).
  ADD COLUMN gate_status text CHECK (gate_status IN ('scored', 'unavailable', 'skipped')),
  ADD COLUMN gate_error_code text CHECK (gate_error_code IS NULL OR char_length(gate_error_code) <= 80),
  ADD COLUMN gate_model text CHECK (gate_model IS NULL OR char_length(gate_model) <= 40),
  ADD COLUMN gate_latency_ms integer CHECK (gate_latency_ms IS NULL OR gate_latency_ms >= 0),
  -- Регистр кандидата по мнению ворот: answer, banter, retort, off.
  ADD COLUMN gate_register text CHECK (gate_register IS NULL OR char_length(gate_register) <= 20),
  ADD COLUMN gate_register_confidence real CHECK (gate_register_confidence IS NULL OR gate_register_confidence BETWEEN 0 AND 1),
  -- «Стоит ли отправлять» как ожидание по уровням 0..3 (0 не стоит, 3 стоит).
  ADD COLUMN gate_worth real CHECK (gate_worth IS NULL OR gate_worth BETWEEN 0 AND 3),
  -- Вероятности провала критериев, 0..1.
  ADD COLUMN gate_escalates real CHECK (gate_escalates IS NULL OR gate_escalates BETWEEN 0 AND 1),
  ADD COLUMN gate_third_party real CHECK (gate_third_party IS NULL OR gate_third_party BETWEEN 0 AND 1),
  ADD COLUMN gate_repeats_self real CHECK (gate_repeats_self IS NULL OR gate_repeats_self BETWEEN 0 AND 1),
  -- Вероятность, что в сообщении был вопрос или поручение Мие.
  ADD COLUMN gate_asked real CHECK (gate_asked IS NULL OR gate_asked BETWEEN 0 AND 1);

CREATE INDEX turn_evaluations_gate_scored
  ON turn_evaluations (telegram_chat_id, started_at DESC) WHERE gate_status = 'scored';
