import type { Metadata } from "next";

import { RecordingPlayerPage } from "../../_recordings/RecordingPlayerPage";
import { safeRecordingsReturnPath } from "../../_recordings/query-state";

export const metadata: Metadata = {
	title: "Recording details"
};

interface PageProps {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/recordings/[id]` — recording detail and playback page.
 *
 * Thin Next.js entry point; the actual UI lives in {@link
 * RecordingPlayerPage}.
 */
export default async function Page({ params, searchParams }: PageProps) {
	const [{ id }, query] = await Promise.all([params, searchParams]);
	const rawReturnTo = Array.isArray(query["returnTo"])
		? query["returnTo"][0]
		: query["returnTo"];
	return (
		<RecordingPlayerPage
			recordingId={id}
			returnTo={safeRecordingsReturnPath(rawReturnTo)}
		/>
	);
}
