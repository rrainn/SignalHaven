import type { Metadata } from "next";

import { PreferencesPage } from "../_preferences/PreferencesPage";

export const metadata: Metadata = {
	title: "Preferences"
};

/** `/preferences` keeps account-owned guide choices outside system settings. */
export default function Page() {
	return <PreferencesPage />;
}
