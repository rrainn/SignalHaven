import type { Metadata } from "next";

import { WatchPage } from "../../_watch/WatchPage";

export const metadata: Metadata = {
	title: "Watch"
};

interface PageProps {
	params: Promise<{ channelId: string }>;
}

/**
 * `/watch/[channelId]` — full live watch page (rrainn/SignalHaven#U7-watch).
 *
 * The channel id seed comes straight from the URL; the client {@link
 * WatchPage} owns subsequent channel switches and keeps the segment in
 * sync via `history.replaceState` so the player isn't remounted on
 * channel up/down.
 */
export default async function Page({ params }: PageProps) {
	const { channelId } = await params;
	return <WatchPage initialChannelId={channelId} />;
}
