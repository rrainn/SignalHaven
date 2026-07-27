"use client";

import dynamic from "next/dynamic";

import { PageHeader } from "../_ui/PageHeader";
import type { GuidePageProps } from "./GuidePage";
import { GuideLoadingSkeleton } from "./GuideLoadingSkeleton";

const ClientOnlyGuidePage = dynamic<GuidePageProps>(
	() => import("./GuidePage").then((module) => module.GuidePage),
	{
		ssr: false,
		loading: GuidePageLoadingShell
	}
);

/**
 * Mounts the responsive guide only in the browser.
 *
 * Safari can restore a native scroll offset before React selectively hydrates
 * a streamed route. Keeping the time-dependent grid out of the server tree
 * gives its virtual viewport and the browser one shared starting position.
 */
export function GuidePageClient(props: GuidePageProps) {
	return <ClientOnlyGuidePage {...props} />;
}

/** Preserves the page's final geometry while the client guide bundle loads. */
function GuidePageLoadingShell() {
	return (
		<section className="space-y-4" aria-labelledby="guide-heading">
			<PageHeader
				headingId="guide-heading"
				title="Guide"
				description="See what is on now and what is coming up across your channels."
			/>
			<GuideLoadingSkeleton />
		</section>
	);
}
