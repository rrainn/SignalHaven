import type { Metadata } from "next";

import { RecordingsPage } from "../_recordings/RecordingsPage";
import { parseRecordingsUrlState } from "../_recordings/query-state";

export const metadata: Metadata = {
	title: "Recordings"
};

/**
 * `/recordings` — recordings library view (rrainn/SignalHaven#U8-recordings).
 *
 * Thin Next.js entry point; the actual UI lives in {@link
 * RecordingsPage} so it can be lazily code-split from other top-level
 * routes.
 */
interface PageProps {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: PageProps) {
	const initialUrlState = parseRecordingsUrlState(await searchParams);
	return <RecordingsPage initialUrlState={initialUrlState} />;
}
