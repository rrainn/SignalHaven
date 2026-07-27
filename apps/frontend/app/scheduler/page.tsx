import type { Metadata } from "next";

import { SchedulerPage } from "../_scheduler/SchedulerPage";

export const metadata: Metadata = {
	title: "Scheduler"
};

/**
 * `/scheduler` — DVR scheduler view (rrainn/SignalHaven#U9-scheduler).
 *
 * Thin Next.js entry point; the actual UI lives in {@link
 * SchedulerPage} so it can be lazily code-split from other top-level
 * routes.
 */
export default function Page() {
	return <SchedulerPage />;
}
