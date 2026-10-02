-- BERTA (768 dimensions) replaces multilingual-e5-small (384). The E5 vectors stay under retired
-- names so a rollback to 1.8.12 can rename them back instead of reindexing; records written after
-- this migration have no E5 vectors and are picked up by that release's `reindex-memory`.
LOCK TABLE memory_items_all, memory_embedding_jobs, memory_embedding_chunks, memory_threads
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE memory_embedding_chunks RENAME TO retired_e5_memory_embedding_chunks;
ALTER INDEX memory_embedding_chunks_pkey RENAME TO retired_e5_memory_embedding_chunks_pkey;
ALTER INDEX memory_embedding_chunks_vector_idx RENAME TO retired_e5_memory_embedding_chunks_vector_idx;
ALTER INDEX memory_embedding_chunks_model_item_idx
  RENAME TO retired_e5_memory_embedding_chunks_model_item_idx;

CREATE TABLE memory_embedding_chunks (
  memory_item_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (char_length(content) > 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  embedding vector(768) NOT NULL,
  embedding_model text NOT NULL CHECK (char_length(embedding_model) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, chunk_index)
);

CREATE INDEX memory_embedding_chunks_vector_idx
  ON memory_embedding_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memory_embedding_chunks_model_item_idx
  ON memory_embedding_chunks (embedding_model, memory_item_id);

-- Titles are immutable; the embedding worker fills the new column for every thread.
ALTER TABLE memory_threads RENAME COLUMN title_embedding TO retired_e5_title_embedding;
ALTER TABLE memory_threads RENAME COLUMN title_embedding_model TO retired_e5_title_embedding_model;
ALTER TABLE memory_threads
  ADD COLUMN title_embedding vector(768),
  ADD COLUMN title_embedding_model text;

-- Every record is reindexed from its authoritative text; until its job completes it is found by
-- words only. Jobs carry the record's own creation time: the worker takes the newest first, so
-- records written after the deploy and recent ones are searchable long before the old tail.
TRUNCATE memory_embedding_jobs;
UPDATE memory_items_all SET embedding_status = 'pending';
INSERT INTO memory_embedding_jobs (memory_item_id, created_at)
SELECT id, created_at FROM memory_items_all;
