"use client";

import type {
	EpgSource,
	Settings,
	Tuner,
	TunerList,
	EpgSourceList
} from "@signalhaven/shared";
import { userPreferencesDefaults } from "@signalhaven/shared";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import {
	ApiError,
	getSettings,
	listEpgSources,
	listTuners
} from "../../lib/api-client";
import { usePreferencesOptional } from "../_preferences/PreferencesProvider";
import { Button } from "../_ui/Button";
import { PageHeader } from "../_ui/PageHeader";
import { Spinner } from "../_ui/Spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../_ui/Tabs";

// Default tab — render eagerly so users landing on /settings see content
// immediately (and so this remains the LCP-relevant section for the
// Lighthouse perf budget).
import { TunersSection } from "./TunersSection";

// Non-default tabs — lazy-loaded to keep the initial /settings bundle
// small. Each section ships its own form/validation code, none of which
// is needed until the user clicks the corresponding tab. Radix Tabs
// unmounts inactive panels, so the dynamic chunks are only fetched on
// demand.
const AboutSection = lazy(() =>
	import("./AboutSection").then((module) => ({
		default: module.AboutSection
	}))
);
const EpgSection = lazy(() =>
	import("./EpgSection").then((m) => ({ default: m.EpgSection }))
);
const StorageSection = lazy(() =>
	import("./StorageSection").then((m) => ({ default: m.StorageSection }))
);
const TranscodingSection = lazy(() =>
	import("./TranscodingSection").then((m) => ({
		default: m.TranscodingSection
	}))
);
const TimeShiftSection = lazy(() =>
	import("./TimeShiftSection").then((module) => ({
		default: module.TimeShiftSection
	}))
);
const UsersSection = lazy(() =>
	import("./UsersSection").then((module) => ({
		default: module.UsersSection
	}))
);

export type SettingsPageProps = {
	/** Optional injected initial data (used by tests to skip the fetch). */
	initialSettings?: Settings;
	initialTuners?: Tuner[];
	initialEpgSources?: EpgSource[];
	/** Override the default tab selection (defaults to "tuners"). */
	defaultTab?: SettingsTab;
};

export type SettingsTab =
	| "tuners"
	| "epg"
	| "storage"
	| "time-shift"
	| "transcoding"
	| "users"
	| "about";

const TABS: ReadonlyArray<{ value: SettingsTab; label: string }> = [
	{ value: "tuners", label: "Tuners" },
	{ value: "epg", label: "EPG Sources" },
	{ value: "storage", label: "Storage" },
	{ value: "time-shift", label: "Live TV Buffer" },
	{ value: "transcoding", label: "Transcoding" },
	{ value: "users", label: "Users" },
	{ value: "about", label: "About" }
];

/**
 * Top-level settings UI (rrainn/SignalHaven#U11-settings).
 *
 * Loads administrator-owned settings, tuners, and EPG sources once on mount.
 * Each section owns its form state and PATCH semantics; this page orchestrates
 * shared loading while account preferences remain in PreferencesProvider.
 */
export function SettingsPage(props: SettingsPageProps) {
	const { initialSettings, initialTuners, initialEpgSources, defaultTab } =
		props;

	const preferences = usePreferencesOptional();
	const [settings, setSettings] = useState<Settings | null>(
		initialSettings ?? null
	);
	const [tuners, setTuners] = useState<Tuner[] | null>(initialTuners ?? null);
	const [epgSources, setEpgSources] = useState<EpgSource[] | null>(
		initialEpgSources ?? null
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const replacePreferences = preferences?.replacePreferences;

	const onSettingsChanged = useCallback((next: Settings) => {
		setSettings(next);
	}, []);

	const refreshSettings = useCallback(async () => {
		try {
			setSettings(await getSettings());
		} catch (err) {
			setLoadError(messageOf(err, "Failed to load settings"));
		}
	}, []);

	const refreshTuners = useCallback(async () => {
		try {
			const list: TunerList = await listTuners();
			setTuners(list.items);
		} catch (err) {
			setLoadError(messageOf(err, "Failed to load tuners"));
		}
	}, []);

	const refreshEpgSources = useCallback(async () => {
		try {
			const list: EpgSourceList = await listEpgSources();
			setEpgSources(list.items);
		} catch (err) {
			setLoadError(messageOf(err, "Failed to load EPG sources"));
		}
	}, []);

	const refreshTunerAndGuideSources = useCallback(async () => {
		setLoadError(null);
		await Promise.all([refreshTuners(), refreshEpgSources()]);
	}, [refreshEpgSources, refreshTuners]);

	const retryMissingResources = useCallback(async () => {
		setLoadError(null);
		const tasks: Promise<void>[] = [];
		if (tuners === null) tasks.push(refreshTuners());
		if (epgSources === null) tasks.push(refreshEpgSources());
		if (settings === null) tasks.push(refreshSettings());
		await Promise.all(tasks);
	}, [
		epgSources,
		refreshEpgSources,
		refreshSettings,
		refreshTuners,
		settings,
		tuners
	]);

	useEffect(() => {
		const tasks: Promise<unknown>[] = [];
		if (!initialSettings) tasks.push(refreshSettings());
		if (!initialTuners) tasks.push(refreshTuners());
		if (!initialEpgSources) tasks.push(refreshEpgSources());
		void Promise.all(tasks);
	}, [
		initialSettings,
		initialTuners,
		initialEpgSources,
		refreshSettings,
		refreshTuners,
		refreshEpgSources
	]);

	const resources =
		settings && tuners && epgSources ? { settings, tuners, epgSources } : null;
	const userPreferences = preferences?.preferences ?? userPreferencesDefaults;

	return (
		<section className="space-y-6" data-testid="settings-page">
			<PageHeader
				headingId="settings-heading"
				title="Settings"
				description="Configure tuners, guide data, recordings storage, transcoding, local users, and system information."
			/>

			<Tabs defaultValue={defaultTab ?? "tuners"}>
				<div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
					<TabsList aria-label="Settings sections" className="min-w-max">
						{TABS.map((tab) => (
							<TabsTrigger
								key={tab.value}
								value={tab.value}
								className="min-h-11 shrink-0 sm:min-h-0"
							>
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
				</div>

				<TabsContent value="tuners">
					{resources ? (
						<TunersSection
							tuners={resources.tuners}
							onChanged={refreshTunerAndGuideSources}
							settings={resources.settings}
							onSettingsChanged={onSettingsChanged}
						/>
					) : (
						<SettingsResourceState
							error={loadError}
							onRetry={retryMissingResources}
						/>
					)}
				</TabsContent>
				<TabsContent value="epg">
					{resources ? (
						<Suspense fallback={<Spinner label="Loading EPG sources…" />}>
							<EpgSection
								sources={resources.epgSources}
								onChanged={refreshEpgSources}
							/>
						</Suspense>
					) : (
						<SettingsResourceState
							error={loadError}
							onRetry={retryMissingResources}
						/>
					)}
				</TabsContent>
				<TabsContent value="storage">
					{resources ? (
						<Suspense fallback={<Spinner label="Loading storage…" />}>
							<StorageSection
								settings={resources.settings}
								onChanged={onSettingsChanged}
							/>
						</Suspense>
					) : (
						<SettingsResourceState
							error={loadError}
							onRetry={retryMissingResources}
						/>
					)}
				</TabsContent>
				<TabsContent value="transcoding">
					{resources ? (
						<Suspense fallback={<Spinner label="Loading transcoding…" />}>
							<TranscodingSection
								settings={resources.settings}
								playerPreferences={userPreferences.player}
								onChanged={onSettingsChanged}
								{...(replacePreferences
									? { onPlayerPreferencesChanged: replacePreferences }
									: {})}
								{...(preferences
									? { savePreferences: preferences.savePreferences }
									: {})}
							/>
						</Suspense>
					) : (
						<SettingsResourceState
							error={loadError}
							onRetry={retryMissingResources}
						/>
					)}
				</TabsContent>
				<TabsContent value="time-shift">
					{resources ? (
						<Suspense fallback={<Spinner label="Loading live TV buffer…" />}>
							<TimeShiftSection
								settings={resources.settings}
								onChanged={onSettingsChanged}
							/>
						</Suspense>
					) : (
						<SettingsResourceState
							error={loadError}
							onRetry={retryMissingResources}
						/>
					)}
				</TabsContent>
				<TabsContent value="users">
					<Suspense fallback={<Spinner label="Loading local users…" />}>
						<UsersSection />
					</Suspense>
				</TabsContent>
				<TabsContent value="about">
					<Suspense fallback={<Spinner label="Loading about…" />}>
						<AboutSection />
					</Suspense>
				</TabsContent>
			</Tabs>
		</section>
	);
}

type SettingsResourceStateProps = {
	error: string | null;
	onRetry: () => Promise<void>;
};

/** Keep each settings tab actionable when its shared resources fail to load. */
function SettingsResourceState({ error, onRetry }: SettingsResourceStateProps) {
	return (
		<div data-testid="settings-loading" className="space-y-3">
			{error ? (
				<>
					<p role="alert" className="text-sm text-danger">
						{error}
					</p>
					<Button
						type="button"
						variant="outline"
						onClick={() => void onRetry()}
					>
						Try again
					</Button>
				</>
			) : (
				<p
					role="status"
					aria-live="polite"
					className="flex items-center gap-2 text-sm text-secondary"
				>
					<Spinner aria-hidden="true" className="h-4 w-4" />
					Loading configuration…
				</p>
			)}
		</div>
	);
}

function messageOf(err: unknown, fallback: string): string {
	if (err instanceof ApiError) return err.message;
	if (err instanceof Error) return err.message;
	return fallback;
}
