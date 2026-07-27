ALTER TABLE epg_channels
  ADD COLUMN IF NOT EXISTS display_names text[] NOT NULL DEFAULT '{}'::text[];

-- Existing rows still need their canonical name available to alias matching.
UPDATE epg_channels
  SET display_names = ARRAY[display_name]
  WHERE cardinality(display_names) = 0;
