-- A taxi ride or a Lavka order the person is told about as it moves on, between turns and without a
-- model: a minute tick looks at the order in the person's own browser and sends a fixed message when
-- its status changes. One active watch per order and person.
ALTER TYPE proactive_delivery_source_kind ADD VALUE IF NOT EXISTS 'order_watch';

CREATE TABLE order_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service text NOT NULL CHECK (service IN ('yandex_taxi', 'yandex_lavka')),
  order_id text NOT NULL CHECK (char_length(order_id) BETWEEN 1 AND 120),
  -- The person's private chat, where the messages go.
  telegram_chat_id text NOT NULL CHECK (char_length(telegram_chat_id) BETWEEN 1 AND 40),
  -- The sandbox whose browser holds the person's Yandex login.
  sandbox_session_id text NOT NULL CHECK (char_length(sandbox_session_id) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  -- What the person was last told; null until the first look.
  last_state jsonb CHECK (last_state IS NULL OR jsonb_typeof(last_state) = 'object'),
  next_check_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 100),
  lease_token uuid,
  lease_expires_at timestamptz,
  finish_reason text CHECK (finish_reason IS NULL OR finish_reason IN ('order_ended', 'deadline', 'failed', 'stopped', 'unreachable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'finished') = (finished_at IS NOT NULL AND finish_reason IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX order_watches_one_active ON order_watches (user_id, service, order_id) WHERE status = 'active';
CREATE INDEX order_watches_due ON order_watches (next_check_at) WHERE status = 'active';
CREATE INDEX order_watches_finished ON order_watches (finished_at) WHERE status = 'finished';

-- Who drives a person's browser right now: a turn (each of its commands renews the mark for two
-- minutes) or a background check holding it for a moment. Both write this one row, so a check never
-- moves the tab under a turn, e.g. one typing an SMS code, and a turn waits for a check to finish.
CREATE TABLE sandbox_browser_holds (
  sandbox_session_id text PRIMARY KEY CHECK (char_length(sandbox_session_id) BETWEEN 1 AND 120),
  holder uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('background', 'turn')),
  expires_at timestamptz NOT NULL
);
