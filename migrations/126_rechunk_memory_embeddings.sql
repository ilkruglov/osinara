-- Chunking changed (5 October 2026): one chunk per paragraph up to a thousand characters, long
-- paragraphs split after sentence ends, instead of fixed 400-character windows that cut
-- sentences and started overlaps mid-word. Vectors of the old chunks stay valid but describe
-- the old pieces, so every visible record is reindexed from its text; until its job completes
-- it is found by words only (the semantic branch skips records that are not `indexed`).
-- Hidden records have no job (migration 124); restoring one queues it anew.
TRUNCATE memory_embedding_jobs;
UPDATE memory_items_all SET embedding_status = 'pending' WHERE deleted_at IS NULL;
INSERT INTO memory_embedding_jobs (memory_item_id, created_at)
SELECT id, created_at FROM memory_items;
