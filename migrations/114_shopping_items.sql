-- Personal shopping lists. A list belongs to one person and lives in their private chat: the
-- family group never sees it (owner's decision, 26 сентября 2026). A bought mark is the moment
-- and nothing else; the buyer is the owner. Same titles are not merged: two milks are two lines.
CREATE TABLE shopping_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_name text NOT NULL CHECK (char_length(list_name) BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  quantity text CHECK (char_length(quantity) BETWEEN 1 AND 50),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  bought_at timestamptz,
  removed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shopping_items_owner_list ON shopping_items(owner_user_id, list_name)
  WHERE removed_at IS NULL;

-- A repeated tool call (the same Eve call id) neither adds a second line nor flips a mark twice.
CREATE TABLE shopping_item_operations (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  request_hash text NOT NULL,
  item_id uuid NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, operation_key)
);
