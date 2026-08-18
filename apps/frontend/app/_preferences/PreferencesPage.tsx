"use client";

import { CirclePlay, ListVideo } from "lucide-react";

import { useAuth } from "../_auth/AuthProvider";
import { SmartLink } from "../_layout/SmartLink";
import { AppearanceSection } from "../_settings/AppearanceSection";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from "../_ui/Card";
import { PageHeader } from "../_ui/PageHeader";
import { usePreferences } from "./PreferencesProvider";

/** Gives every account a clear home for its guide and playback choices. */
export function PreferencesPage() {
	const auth = useAuth();
	const preferences = usePreferences();
	const user = auth.state.status === "signed-in" ? auth.state.user : null;

	return (
		<section className="space-y-6" data-testid="preferences-page">
			<PageHeader
				headingId="preferences-heading"
				title="Your preferences"
				description={
					user
						? `These guide and playback choices belong to ${user.username}.`
						: "These guide and playback choices belong to your account."
				}
			/>

			<div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
				<AppearanceSection
					preferences={preferences.preferences.ui}
					onChanged={preferences.replacePreferences}
					savePreferences={preferences.savePreferences}
					showAdvancedMode={user?.role === "admin"}
				/>

				<div className="space-y-4">
					<Card>
						<CardHeader>
							<div className="flex items-center gap-2">
								<ListVideo aria-hidden="true" className="h-4 w-4 text-accent" />
								<CardTitle>Channels</CardTitle>
							</div>
							<CardDescription>
								Favorites, hidden channels, and ordering are private to this
								account.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<SmartLink
								href="/channels"
								className="text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
							>
								Customize channels
							</SmartLink>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<div className="flex items-center gap-2">
								<CirclePlay
									aria-hidden="true"
									className="h-4 w-4 text-accent"
								/>
								<CardTitle>Playback</CardTitle>
							</div>
							<CardDescription>
								Volume, captions, and channel quality choices save as you use
								the player.
							</CardDescription>
						</CardHeader>
					</Card>
				</div>
			</div>
		</section>
	);
}
