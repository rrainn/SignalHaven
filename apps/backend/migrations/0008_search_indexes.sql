-- Global search support (rrainn/SignalHaven#U10-search).
--
-- The EPG `search_tsv` column + GIN index already exist (see
-- `0000_initial_schema.sql`). This migration adds the indexes the
-- channel half of the unified search relies on:
--
--   * `pg_trgm` extension — powers `similarity()` / `%` operators used to
--     match channel names tolerantly (typo-friendly, partial words).
--   * `channels_name_trgm_idx` — GIN trigram index so the `name % q` and
--     `similarity(name, q)` predicates are index-supported even for the
--     low-selectivity short-string queries the search box typically
--     issues.
--   * `channels_number_idx` — btree on `number` so `number LIKE 'q%'`
--     prefix lookups (e.g. user types "12.") use an index range scan.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS channels_name_trgm_idx
  ON channels USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS channels_number_idx
  ON channels (number text_pattern_ops);
