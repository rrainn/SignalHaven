import type { Metadata } from "next";

import { ProgramDetailsPage } from "../../_guide/ProgramDetailsPage";
import { safeGuideReturnPath } from "../../_guide/guide-return-path";

export const metadata: Metadata = {
	title: "Program details"
};

interface PageProps {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Stable route for program details opened from search and shared links. */
export default async function Page({ params, searchParams }: PageProps) {
	const [{ id }, query] = await Promise.all([params, searchParams]);
	const rawReturnTo = Array.isArray(query["returnTo"])
		? query["returnTo"][0]
		: query["returnTo"];
	return (
		<ProgramDetailsPage
			programId={id}
			returnTo={safeGuideReturnPath(rawReturnTo)}
		/>
	);
}
