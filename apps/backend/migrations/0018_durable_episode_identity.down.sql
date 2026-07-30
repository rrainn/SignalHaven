DROP INDEX IF EXISTS series_rule_episodes_recording_idx;
DROP INDEX IF EXISTS recordings_episode_identity_idx;
DROP TABLE IF EXISTS series_rule_episodes;

ALTER TABLE series_rules
  DROP COLUMN IF EXISTS episode_policy;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS episode_original_air_date,
  DROP COLUMN IF EXISTS episode_artwork_url,
  DROP COLUMN IF EXISTS episode_categories,
  DROP COLUMN IF EXISTS episode_number,
  DROP COLUMN IF EXISTS episode_season,
  DROP COLUMN IF EXISTS episode_description,
  DROP COLUMN IF EXISTS episode_subtitle,
  DROP COLUMN IF EXISTS episode_identity_key;

ALTER TABLE epg_programs
  DROP COLUMN IF EXISTS newness_source,
  DROP COLUMN IF EXISTS broadcast_newness,
  DROP COLUMN IF EXISTS original_air_date,
  DROP COLUMN IF EXISTS episode_identity_key,
  DROP COLUMN IF EXISTS provider_episode_id;

DROP TABLE IF EXISTS episodes;
