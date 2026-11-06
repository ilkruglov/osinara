-- Telegram widget messages (Bot API 10.4 beta) sent by Mia from a workspace HTML file go through the
-- same delivery reservation as photos and documents: one row per tool call, the same replay and
-- per-turn duplicate checks. Only the presentation gains a third value.
ALTER TABLE workspace_file_deliveries DROP CONSTRAINT workspace_file_deliveries_presentation_check;
ALTER TABLE workspace_file_deliveries ADD CONSTRAINT workspace_file_deliveries_presentation_check
  CHECK (presentation IN ('document', 'photo', 'widget'));
