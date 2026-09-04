-- Reminders become available inside external Telegram groups, where a participant has no account
-- in this application. The scope value lands in its own migration because PostgreSQL forbids using
-- a freshly added enum value in the transaction that added it, and every file here is one
-- transaction. Columns, constraints and indexes for the new scope follow in the next migration.
ALTER TYPE reminder_scope ADD VALUE IF NOT EXISTS 'group';
