import type { Metadata } from "next";

import { SeriesDetailPage } from "../../../_recordings/SeriesDetailPage";
import { safeRecordingsReturnPath } from "../../../_recordings/query-state";

export const metadata: Metadata = {
	title: "Series"
};

interface PageProps {
	params: Promise<{ seriesRuleId: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/recordings/series/[seriesRuleId]` — per-series detail view
 * (rrainn/SignalHaven#U8-recordings).
 */
export default async function Page({ params, searchParams }: PageProps) {
	const [{ seriesRuleId }, query] = await Promise.all([params, searchParams]);
	const rawReturnTo = Array.isArray(query["returnTo"])
		? query["returnTo"][0]
		: query["returnTo"];
	const rawPages = Array.isArray(query["pages"])
		? query["pages"][0]
		: query["pages"];
	const parsedPages = Number.parseInt(rawPages ?? "1", 10);
	return (
		<SeriesDetailPage
			seriesRuleId={seriesRuleId}
			returnTo={safeRecordingsReturnPath(rawReturnTo)}
			initialPageCount={
				Number.isFinite(parsedPages)
					? Math.min(1_000, Math.max(1, parsedPages))
					: 1
			}
		/>
	);
}
