-- Durable episode identity and provider-backed newness survive EPG pruning.
CREATE TABLE IF NOT EXISTS episodes (
  identity_key text PRIMARY KEY,
  provider_episode_id text,
  series_key text NOT NULL,
  season integer,
  episode integer,
  subtitle text,
  original_air_date date,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE epg_programs
  ADD COLUMN IF NOT EXISTS provider_episode_id text,
  ADD COLUMN IF NOT EXISTS episode_identity_key text REFERENCES episodes(identity_key) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS original_air_date date,
  ADD COLUMN IF NOT EXISTS broadcast_newness text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS newness_source text NOT NULL DEFAULT 'none';

-- Existing numbered guide rows receive the same deterministic fallback used by
-- the importer, so upgrades do not discard useful episode identity.
INSERT INTO episodes (identity_key, series_key, season, episode, subtitle)
SELECT DISTINCT
  'title:' || regexp_replace(lower(btrim(title)), '\s+', ' ', 'g') ||
    ':s' || season::text || ':e' || episode::text,
  regexp_replace(lower(btrim(title)), '\s+', ' ', 'g'),
  season,
  episode,
  subtitle
FROM epg_programs
WHERE season IS NOT NULL AND episode IS NOT NULL
ON CONFLICT (identity_key) DO NOTHING;

UPDATE epg_programs
SET episode_identity_key =
  'title:' || regexp_replace(lower(btrim(title)), '\s+', ' ', 'g') ||
    ':s' || season::text || ':e' || episode::text
WHERE episode_identity_key IS NULL
  AND season IS NOT NULL
  AND episode IS NOT NULL;

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS episode_identity_key text REFERENCES episodes(identity_key) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS episode_subtitle text,
  ADD COLUMN IF NOT EXISTS episode_description text,
  ADD COLUMN IF NOT EXISTS episode_season integer,
  ADD COLUMN IF NOT EXISTS episode_number integer,
  ADD COLUMN IF NOT EXISTS episode_categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS episode_artwork_url text,
  ADD COLUMN IF NOT EXISTS episode_original_air_date date;

-- Snapshot all metadata that is still available at migration time.
UPDATE recordings recording
SET
  episode_identity_key = program.episode_identity_key,
  episode_subtitle = program.subtitle,
  episode_description = program.description,
  episode_season = program.season,
  episode_number = program.episode,
  episode_categories = program.categories,
  episode_artwork_url = program.artwork_url,
  episode_original_air_date = program.original_air_date
FROM epg_programs program
WHERE recording.program_id = program.id;

ALTER TABLE series_rules
  ADD COLUMN IF NOT EXISTS episode_policy text NOT NULL DEFAULT 'all';

UPDATE series_rules
SET episode_policy = CASE
  WHEN new_only THEN 'confirmed_new'
  ELSE 'all'
END;

CREATE TABLE IF NOT EXISTS series_rule_episodes (
  series_rule_id uuid NOT NULL REFERENCES series_rules(id) ON DELETE CASCADE,
  episode_identity_key text NOT NULL REFERENCES episodes(identity_key) ON DELETE CASCADE,
  state text NOT NULL,
  recording_id uuid REFERENCES recordings(id) ON DELETE SET NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_rule_id, episode_identity_key)
);

CREATE INDEX IF NOT EXISTS recordings_episode_identity_idx
  ON recordings (episode_identity_key);

CREATE INDEX IF NOT EXISTS series_rule_episodes_recording_idx
  ON series_rule_episodes (recording_id)
  WHERE recording_id IS NOT NULL;
