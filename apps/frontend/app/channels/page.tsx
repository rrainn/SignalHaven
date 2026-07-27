import type { Metadata } from "next";

import { ChannelsPage } from "../_channels/ChannelsPage";

export const metadata: Metadata = {
	title: "Channels"
};

/**
 * `/channels` — channel-centric list view (U5-channels).
 *
 * The actual UI lives in {@link ChannelsPage}; this thin route file is
 * just the Next.js entry point so the page can be lazily code-split
 * from the other top-level routes.
 */
export default function Page() {
	return <ChannelsPage />;
}
