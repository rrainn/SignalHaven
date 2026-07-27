CREATE TABLE IF NOT EXISTS tuners (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY,
  tuner_id uuid NOT NULL REFERENCES tuners(id) ON DELETE CASCADE,
  number text NOT NULL,
  name text NOT NULL,
  logo_url text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL
);

CREATE TABLE IF NOT EXISTS epg_channels (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES tuners(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  display_name text NOT NULL,
  CONSTRAINT epg_channels_source_external_unique UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS epg_programs (
  id uuid PRIMARY KEY,
  epg_channel_id uuid NOT NULL REFERENCES epg_channels(id) ON DELETE CASCADE,
  start timestamptz NOT NULL,
  stop timestamptz NOT NULL,
  title text NOT NULL,
  subtitle text,
  description text,
  episode integer,
  season integer,
  categories text[] NOT NULL DEFAULT '{}'::text[],
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(subtitle, '') || ' ' || coalesce(description, '')
    )
  ) STORED
);

CREATE TABLE IF NOT EXISTS channel_epg_map (
  channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  epg_channel_id uuid NOT NULL REFERENCES epg_channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recordings (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  program_id uuid REFERENCES epg_programs(id) ON DELETE SET NULL,
  status text NOT NULL,
  scheduled_start timestamptz NOT NULL,
  scheduled_end timestamptz NOT NULL,
  actual_start timestamptz,
  actual_end timestamptz,
  file_path text,
  file_size bigint,
  error_message text
);

CREATE TABLE IF NOT EXISTS series_rules (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  epg_channel_id uuid REFERENCES epg_channels(id) ON DELETE SET NULL,
  keep_count integer NOT NULL,
  new_only boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS channels_tuner_sort_idx ON channels (tuner_id, sort_order);
CREATE INDEX IF NOT EXISTS epg_programs_epg_channel_start_idx ON epg_programs (epg_channel_id, start);
CREATE INDEX IF NOT EXISTS epg_programs_search_tsv_idx ON epg_programs USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS recordings_status_scheduled_start_idx ON recordings (status, scheduled_start);
