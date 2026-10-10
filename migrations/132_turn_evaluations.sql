-- Оценка каждого хода без модели: три уровня (результат, процесс, удовлетворённость) и версии,
-- при которых ход шёл. Живые ходы только собирают сведения; решения о выкатке принимаются по ним
-- отдельно. Текст сообщений людей сюда не попадает: только идентификаторы, коды и счётчики.
--
-- Строку пишут два источника в любом порядке: хук конца хода (результат, процесс, версии) и канал
-- доставки (id отправленных сообщений Мии), поэтому запись идёт через upsert по ходу Eve.
CREATE TABLE turn_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  eve_session_id text NOT NULL CHECK (char_length(eve_session_id) BETWEEN 1 AND 200),
  eve_turn_id text NOT NULL CHECK (char_length(eve_turn_id) BETWEEN 1 AND 200),
  chat_kind text NOT NULL CHECK (chat_kind IN ('private', 'family', 'external')),
  telegram_chat_id text,
  triggering_entry_id uuid REFERENCES telegram_group_messages(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Результат: чем кончился ход.
  outcome text CHECK (outcome IN ('completed', 'failed')),
  failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) <= 120),
  step_count integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls) = 'array'),
  failed_tool_count integer NOT NULL DEFAULT 0 CHECK (failed_tool_count >= 0),
  loaded_skills text[] NOT NULL DEFAULT '{}',
  -- Процесс: сигналы без модели.
  repeated_call_run integer NOT NULL DEFAULT 0 CHECK (repeated_call_run >= 0),
  repeat_after_error boolean NOT NULL DEFAULT false,
  forbidden_tool boolean NOT NULL DEFAULT false,
  -- Доставка: сообщения Мии, к которым привязываются реакции и ответы людей.
  reply_message_ids bigint[] NOT NULL DEFAULT '{}',
  delivered_at timestamptz,
  -- Версии: ходы разных версий между собой не сравниваются.
  software_version text NOT NULL CHECK (char_length(software_version) BETWEEN 1 AND 40),
  model_config_hash text NOT NULL CHECK (model_config_hash ~ '^[0-9a-f]{16,64}$'),
  prompt_hash text NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{16,64}$'),
  UNIQUE (eve_session_id, eve_turn_id)
);

CREATE INDEX turn_evaluations_family_started ON turn_evaluations (family_id, started_at DESC);
CREATE INDEX turn_evaluations_chat_delivered
  ON turn_evaluations (telegram_chat_id, delivered_at) WHERE delivered_at IS NOT NULL;

-- Реакции людей на сообщения Telegram: единственный прямой сигнал удовлетворённости без модели.
-- Telegram присылает их только администратору чата и только при подписке на message_reaction;
-- одна строка на сообщение и человека, повторное изменение заменяет набор эмодзи.
CREATE TABLE telegram_message_reactions (
  telegram_chat_id text NOT NULL CHECK (char_length(telegram_chat_id) BETWEEN 1 AND 40),
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  telegram_user_id text NOT NULL CHECK (char_length(telegram_user_id) BETWEEN 1 AND 40),
  emojis text[] NOT NULL,
  changed_at timestamptz NOT NULL,
  -- Даты Telegram в секундах: порядок событий одной секунды задаёт update_id.
  update_id bigint NOT NULL CHECK (update_id >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_chat_id, telegram_message_id, telegram_user_id)
);
