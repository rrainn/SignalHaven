DROP INDEX IF EXISTS channels_number_idx;
DROP INDEX IF EXISTS channels_name_trgm_idx;
-- Intentionally NOT dropping the pg_trgm extension here: other
-- indexes (or future migrations) may depend on it, and re-creating
-- the extension is far more expensive than recreating the indexes.
