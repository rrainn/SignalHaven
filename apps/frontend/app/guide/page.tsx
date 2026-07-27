import type { Metadata } from "next";

import { GuidePageClient } from "../_guide/GuidePageClient";

export const metadata: Metadata = {
	title: "Guide"
};

/**
 * `/guide` — the live grid guide screen (U4-guide).
 *
 * The actual UI lives behind {@link GuidePageClient}; this thin route file is just
 * the Next.js entry point so the page can be lazily code-split from the
 * other top-level routes.
 */
interface PageProps {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: PageProps) {
	const query = await searchParams;
	const rawAt = Array.isArray(query["at"]) ? query["at"][0] : query["at"];
	const rawChannel = Array.isArray(query["channel"])
		? query["channel"][0]
		: query["channel"];
	const parsedAt = rawAt ? new Date(rawAt) : null;
	const initialTime =
		parsedAt && Number.isFinite(parsedAt.getTime()) ? parsedAt : undefined;

	return (
		<GuidePageClient initialTime={initialTime} initialChannelId={rawChannel} />
	);
}
