-- Literal recordings-library title search uses the pg_trgm extension
-- introduced by 0008 and stays fast as the library grows.
CREATE INDEX IF NOT EXISTS recordings_title_trgm_idx
  ON recordings USING GIN (title gin_trgm_ops);
