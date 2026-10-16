-- Migration 002: drop the review queue projection.
--
-- The approval queue was removed on 2026-07-28 (owner's decision). A captured
-- item is now either auto-promoted into the curated layer or discarded, so no
-- row ever waits for a human decision.
--
-- The index is rebuildable, so a fresh database simply never creates this table
-- (see ../schema.sql). This migration exists for the databases that already
-- have it: without the DROP, an existing index would keep the old rows forever,
-- and "the item is discarded" would not be true on the machines that matter.
DROP INDEX IF EXISTS ix_pending_open;
DROP TABLE IF EXISTS pending;
