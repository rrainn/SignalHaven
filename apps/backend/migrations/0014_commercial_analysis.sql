CREATE TABLE commercial_analyses (
	recording_id uuid PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
	status text NOT NULL,
	scheduled_job_id uuid,
	detector_version text,
	queued_at timestamptz,
	started_at timestamptz,
	completed_at timestamptz,
	failed_at timestamptz,
	diagnostic_message text,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing recordings begin in the same durable state as newly-created rows.
INSERT INTO commercial_analyses (recording_id, status)
	SELECT id, 'not_requested' FROM recordings;

CREATE TABLE commercial_markers (
	id uuid PRIMARY KEY,
	recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
	start_ms integer NOT NULL CHECK (start_ms >= 0),
	end_ms integer NOT NULL CHECK (end_ms > start_ms)
);

CREATE INDEX commercial_markers_recording_start_idx
	ON commercial_markers (recording_id, start_ms);
