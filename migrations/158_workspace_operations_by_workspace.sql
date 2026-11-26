-- The last message of a Telegram series lists the files its earlier messages stored, found by the
-- prefix of their replay key within one workspace (`findBinaryWritesByKeyPrefixes`, 26 November
-- 2026). The key's own index cannot serve a prefix under the database collation, so every such
-- lookup scanned the operations of all workspaces. Under collation "C" a prefix (`starts_with`) is
-- a range of this index, within the one workspace.
CREATE INDEX workspace_operations_workspace_key
  ON workspace_operations (workspace_id, (operation_key COLLATE "C"));
