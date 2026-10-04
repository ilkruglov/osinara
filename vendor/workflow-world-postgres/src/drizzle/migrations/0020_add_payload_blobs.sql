-- Osinara fork (4 October 2026). Large strings of event payloads (the system prompt, instruction
-- blocks, the history snapshot of a session) are stored once by content hash; the event keeps a
-- marker. A reference row per run and hash lets the run's deletion free its blobs; `touched_at` is refreshed
-- by every write under the row's lock, which is what keeps the sweep from racing a writer.
CREATE TABLE "workflow"."workflow_payload_blobs" (
  "hash" varchar(64) PRIMARY KEY,
  "bytes" bytea NOT NULL,
  "size" integer NOT NULL,
  "touched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_payload_blob_refs" (
  "run_id" varchar NOT NULL,
  "hash" varchar(64) NOT NULL,
  CONSTRAINT "workflow_payload_blob_refs_pk" PRIMARY KEY ("run_id", "hash")
);
--> statement-breakpoint
CREATE INDEX "workflow_payload_blob_refs_hash_index" ON "workflow"."workflow_payload_blob_refs" ("hash");
