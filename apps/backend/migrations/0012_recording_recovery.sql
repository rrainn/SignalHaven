-- Preserve why a completed recording is partial after late-start recovery.
ALTER TABLE recordings
	ADD COLUMN IF NOT EXISTS start_reason text;

-- Recording jobs need bounded retries for transient source/tuner failures.
UPDATE scheduled_jobs
SET max_attempts = 3
WHERE kind = 'recording' AND max_attempts < 3;
