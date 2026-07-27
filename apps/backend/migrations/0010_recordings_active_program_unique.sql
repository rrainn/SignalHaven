-- Make record-by-program scheduling safe to retry (rrainn/SignalHaven#86).
--
-- Preserve the most useful active row for each program before adding the
-- partial unique index. Pending jobs owned by superseded rows are cancelled
-- so an upgrade cannot leave duplicate work armed in the scheduler.

WITH ranked AS (
	SELECT
		id,
		scheduler_job_id,
		row_number() OVER (
			PARTITION BY program_id
			ORDER BY
				CASE status WHEN 'recording' THEN 0 ELSE 1 END,
				created_at,
				id
		) AS duplicate_rank
	FROM recordings
	WHERE
		program_id IS NOT NULL
		AND status IN ('scheduled', 'recording')
)
UPDATE scheduled_jobs
SET
	status = 'cancelled',
	locked_at = NULL,
	updated_at = now()
FROM ranked
WHERE
	ranked.duplicate_rank > 1
	AND ranked.scheduler_job_id = scheduled_jobs.id
	AND scheduled_jobs.status = 'pending';

WITH ranked AS (
	SELECT
		id,
		row_number() OVER (
			PARTITION BY program_id
			ORDER BY
				CASE status WHEN 'recording' THEN 0 ELSE 1 END,
				created_at,
				id
		) AS duplicate_rank
	FROM recordings
	WHERE
		program_id IS NOT NULL
		AND status IN ('scheduled', 'recording')
)
UPDATE recordings
SET
	status = 'cancelled',
	error_message = 'superseded_duplicate',
	updated_at = now()
FROM ranked
WHERE
	ranked.duplicate_rank > 1
	AND ranked.id = recordings.id;

CREATE UNIQUE INDEX IF NOT EXISTS recordings_active_program_unique
	ON recordings (program_id)
	WHERE
		program_id IS NOT NULL
		AND status IN ('scheduled', 'recording');
