-- DVR record-by-program (rrainn/SignalHaven#R2-epg-record): track the active
-- scheduler job behind every `scheduled` recording so we can cancel and
-- re-arm it cleanly when the linked EPG program shifts in time.
ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS scheduler_job_id uuid;
