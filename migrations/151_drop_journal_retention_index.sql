-- The retention index of migration 033 served the pruning of the journal to 10 000 entries per
-- chat, removed with migration 148's release (owner, 22 November 2026: «Убрать лимит»). It copies the
-- unique (group_id, sequence_id), which the planner already scans backward for every journal read
-- (checked on 460 000 rows, 23 November 2026), and only costs every insert.
DROP INDEX telegram_group_messages_retention;
