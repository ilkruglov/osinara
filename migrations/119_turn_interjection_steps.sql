-- Доставка сообщений, показанных идущему ходу, теперь привязана к номеру шага модели (ревью Codex,
-- 28 сентября 2026). Eve повторяет прерванный шаг с тем же номером и исходной историей: прежняя
-- отметка «следующий шаг начался» считала доставленным результат брошенной попытки, которого в
-- восстановленном запросе нет, и сообщение «стоп» больше не показывалось ходу.
--
-- telegram_turn_steps хранит последний начатый шаг хода (только для ходов, которым показываются
-- такие сообщения). returned_step это шаг, во время которого результат с сообщением вернулся;
-- начало шага N доставляет строки с returned_step < N и освобождает незавершённые строки с
-- returned_step >= N: они от попытки, которую Eve выбросила.
ALTER TABLE telegram_turn_interjections ADD COLUMN returned_step integer CHECK (returned_step >= 0);

CREATE TABLE telegram_turn_steps (
  eve_session_id text NOT NULL CHECK (char_length(eve_session_id) > 0),
  eve_turn_id text NOT NULL CHECK (char_length(eve_turn_id) > 0),
  step_index integer NOT NULL CHECK (step_index >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (eve_session_id, eve_turn_id)
);
CREATE INDEX telegram_turn_steps_started ON telegram_turn_steps (started_at);
