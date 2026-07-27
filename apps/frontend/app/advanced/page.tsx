import type { Metadata } from "next";

import { AdvancedPage } from "../_advanced/AdvancedPage";

export const metadata: Metadata = { title: "Advanced" };

export default function Page() {
	return <AdvancedPage />;
}
