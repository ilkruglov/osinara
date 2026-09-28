-- One row per Lavka side effect of a tool call (add to cart, order, cancel), keyed by the Eve
-- session and call id. A step Eve replays after a crash reaches the same key: a completed row
-- returns its stored result, a started one means the first attempt may have reached Lavka and the
-- person must look before repeating (review, 28 September 2026: a replayed add doubled the
-- quantity, a replayed order could submit twice).
CREATE TABLE lavka_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 300),
  action text NOT NULL CHECK (action IN ('add', 'order', 'cancel')),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  status text NOT NULL CHECK (status IN ('started', 'completed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, operation_key),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX lavka_operations_created ON lavka_operations(created_at);
