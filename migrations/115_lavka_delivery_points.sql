-- Where a person's Yandex Lavka orders go: one delivery point per person, chosen once from their
-- saved Lavka addresses or resolved from text, and reused by every catalogue, cart and order call
-- (the Lavka catalogue and cart are location-scoped). Lives in the private chat only; the family
-- group never orders. Replaced in place: the previous point is not history.
CREATE TABLE lavka_delivery_points (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  point jsonb NOT NULL CHECK (
    jsonb_typeof(point) = 'object'
    AND jsonb_typeof(point->'lat') = 'number'
    AND jsonb_typeof(point->'lon') = 'number'
    AND jsonb_typeof(point->'label') = 'string'
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);
