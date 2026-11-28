-- Distingue candidatos de polling y del feed SSE.
-- Idempotente para aplicarse con psql sin runner.

ALTER TABLE shadow.hunter_polls
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'poll';
ALTER TABLE shadow.hunter_candidates
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'poll';
