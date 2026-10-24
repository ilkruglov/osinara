-- One row per Yandex Go side effect of a tool call (an order, a cancellation), keyed by the Eve
-- session and call id. A step Eve replays after a crash reaches the same key: a completed row
-- returns its stored result, a started one means the first attempt may have reached Yandex Go and
-- the person must look at the order status before repeating (an order sent twice is a second car).
CREATE TABLE yandex_taxi_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 300),
  action text NOT NULL CHECK (action IN ('order', 'cancel')),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  status text NOT NULL CHECK (status IN ('started', 'completed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, operation_key),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX yandex_taxi_operations_created ON yandex_taxi_operations(created_at);
