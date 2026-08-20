import type { Metadata } from "next";

import { SettingsPage } from "../_settings/SettingsPage";

export const metadata: Metadata = {
	title: "Settings"
};

/**
 * `/settings` — administrator config for tuners, EPG, storage, transcoding,
 * users, and system information (rrainn/SignalHaven#U11-settings).
 *
 * The actual UI lives in {@link SettingsPage}; this thin route file is
 * just the Next.js entry point so the page can be lazily code-split
 * from the other top-level routes.
 */
export default function Page() {
	return <SettingsPage />;
}
