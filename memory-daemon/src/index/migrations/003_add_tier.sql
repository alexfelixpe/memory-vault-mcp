-- Migration 003: the chunk density tier.
--
-- Answer to the 2026-07-29 review: retrieval should be able to tell a
-- distilled section (a meeting Summary, a topic note) from verbatim speech
-- (a Transcript, a session copy). The tier is a RANKING signal only: it never
-- touches the trust fence, never touches auto-promotion, and never overrides
-- origin. This migration only adds the column; the real values arrive on the
-- next reconcile, forced by the SCANNER_VERSION bump that ships with it.
ALTER TABLE chunks ADD COLUMN tier TEXT NOT NULL DEFAULT 'processed';
