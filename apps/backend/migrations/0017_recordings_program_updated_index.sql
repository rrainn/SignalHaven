-- Guide annotation reads every recording state for a bounded set of programs.
CREATE INDEX IF NOT EXISTS recordings_program_updated_idx
	ON recordings (program_id, updated_at DESC);
