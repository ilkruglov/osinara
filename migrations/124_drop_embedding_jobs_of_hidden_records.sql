-- Migration 123 queued every record for BERTA, soft-deleted ones included, although a hidden record
-- never has an embedding job (soft delete removes it, restore creates it again). Three such jobs
-- were left pending on production; restoring the record queues it anew.
DELETE FROM memory_embedding_jobs AS job
 WHERE NOT EXISTS (SELECT 1 FROM memory_items AS item WHERE item.id = job.memory_item_id);
