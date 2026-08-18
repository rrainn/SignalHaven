"use client";

import type { ReactNode } from "react";

import { AdvancedModeProvider } from "../_advanced/AdvancedModeProvider";
import { AppShell } from "../_layout/AppShell";
import { OnboardingProvider } from "../_onboarding/OnboardingProvider";
import {
	PreferencesProvider,
	usePreferences
} from "../_preferences/PreferencesProvider";
import { Button } from "../_ui/Button";
import { Spinner } from "../_ui/Spinner";
import { AuthSurface } from "./AuthSurface";
import { useAuth } from "./AuthProvider";

/** Mounts all account-owned application state only after authentication succeeds. */
export function AuthenticatedApplication({
	children
}: {
	children: ReactNode;
}) {
	const auth = useAuth();
	const isAdministrator =
		auth.state.status === "signed-in" && auth.state.user.role === "admin";
	return (
		<PreferencesProvider>
			<PreferencesApplication isAdministrator={isAdministrator}>
				{children}
			</PreferencesApplication>
		</PreferencesProvider>
	);
}

/** Keeps account-owned screens unmounted until their complete snapshot is known. */
function PreferencesApplication(props: {
	children: ReactNode;
	isAdministrator: boolean;
}) {
	const preferences = usePreferences();
	if (preferences.status === "loading") {
		return (
			<AuthSurface
				title="Loading your SignalHaven"
				description="Opening your private guide, playback, and channel preferences."
			>
				<div className="flex min-h-24 items-center justify-center">
					<Spinner label="Loading your preferences…" />
				</div>
			</AuthSurface>
		);
	}
	if (preferences.status === "error") {
		return (
			<AuthSurface
				title="Your preferences could not be opened"
				description="SignalHaven keeps your library locked until it can load the complete account snapshot."
			>
				<div className="space-y-4">
					<p role="alert" className="text-sm leading-6 text-danger">
						{preferences.error?.message ??
							"Saved preferences could not be loaded."}
					</p>
					<Button block onClick={() => void preferences.retry()}>
						Try again
					</Button>
				</div>
			</AuthSurface>
		);
	}

	return (
		<AdvancedModeProvider isAdministrator={props.isAdministrator}>
			<OnboardingProvider>
				<AppShell>{props.children}</AppShell>
			</OnboardingProvider>
		</AdvancedModeProvider>
	);
}
