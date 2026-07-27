-- Channel ↔ EPG mapping support (rrainn/SignalHaven E3-mapping).
--
-- A channel may carry an XMLTV-style `tvg-id` (e.g. set on M3U entries)
-- which uniquely matches the `external_id` of an EPG channel under any
-- source. We persist it on the channel row so the auto-matcher can use
-- it as the highest-confidence signal.
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS tvg_id text;

CREATE INDEX IF NOT EXISTS channels_tvg_id_idx ON channels (tvg_id);

-- `manual` distinguishes user-overridden mappings from auto-generated
-- ones; the auto-matcher must never overwrite a manual mapping.
ALTER TABLE channel_epg_map
  ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;
