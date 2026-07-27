CREATE TABLE IF NOT EXISTS epg_sources (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  url text,
  file_path text,
  refresh_interval_minutes integer NOT NULL DEFAULT 720,
  timezone text,
  enabled boolean NOT NULL DEFAULT true,
  last_refresh_at timestamptz,
  last_refresh_status text,
  last_refresh_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT epg_sources_url_or_path CHECK (
    (url IS NOT NULL) OR (file_path IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS epg_sources_kind_idx ON epg_sources (kind);

-- Re-point epg_channels.source_id to reference epg_sources(id) instead of
-- tuners(id). The original F2-db schema borrowed tuners as the EPG source
-- entity as a placeholder; E1-xmltv introduces real EPG sources.
ALTER TABLE epg_channels DROP CONSTRAINT IF EXISTS epg_channels_source_id_tuners_id_fk;
ALTER TABLE epg_channels DROP CONSTRAINT IF EXISTS epg_channels_source_id_fkey;

ALTER TABLE epg_channels
  ADD CONSTRAINT epg_channels_source_id_epg_sources_id_fk
    FOREIGN KEY (source_id) REFERENCES epg_sources(id) ON DELETE CASCADE;

-- Stable identity for upserts during XMLTV refresh.
ALTER TABLE epg_programs
  ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS epg_programs_channel_external_start_uidx
  ON epg_programs (epg_channel_id, external_id, start)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS epg_programs_channel_start_uidx
  ON epg_programs (epg_channel_id, start)
  WHERE external_id IS NULL;
