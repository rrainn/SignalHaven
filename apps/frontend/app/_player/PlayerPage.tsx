"use client";

import { settingsDefaults, type PlayerSettings } from "@signalhaven/shared";
import { useCallback, useEffect, useState } from "react";

import { updateSettings } from "../../lib/api-client";
import { usePreferencesOptional } from "../_preferences/PreferencesProvider";
import { Player, type PlayerSavePayload } from "./Player";

export interface PlayerPageProps {
	channelId: string;
	/** When true, exposes the seek bar and double-tap seek (recordings). */
	isRecording?: boolean;
	/**
	 * Initial preferences override used by tests and isolated previews.
	 */
	initialPlayerSettings?: PlayerSettings | undefined;
	/**
	 * Persistence override for tests. Defaults to PATCH /api/v1/settings
	 * with the merged `player` payload.
	 */
	persist?: ((next: PlayerSettings) => Promise<void>) | undefined;
	/** Optional dismiss handler (modal-style overlay use). */
	onDismiss?: () => void;
}

/**
 * Route-level wrapper around {@link Player} that handles persistence of
 * player preferences via the settings API. Splits the network concerns
 * out of the player itself so the player stays pure / testable.
 */
export function PlayerPage(props: PlayerPageProps) {
	const {
		channelId,
		isRecording = false,
		initialPlayerSettings,
		persist,
		onDismiss
	} = props;
	const preferences = usePreferencesOptional();

	const [settings, setSettings] = useState<PlayerSettings | null>(
		initialPlayerSettings ??
			(preferences
				? preferences.status === "loading"
					? null
					: preferences.settings.player
				: settingsDefaults.player)
	);

	useEffect(() => {
		if (initialPlayerSettings) return;
		if (preferences) {
			if (preferences.status !== "loading") {
				setSettings(preferences.settings.player);
			}
			return;
		}
		setSettings(settingsDefaults.player);
	}, [initialPlayerSettings, preferences]);

	const onPersist = useCallback(
		async (patch: PlayerSavePayload) => {
			if (!settings) return;
			const next: PlayerSettings = {
				volume: patch.volume ?? settings.volume,
				muted: patch.muted ?? settings.muted,
				captionsEnabled: patch.captionsEnabled ?? settings.captionsEnabled,
				qualityByChannel: { ...settings.qualityByChannel }
			};
			if (patch.quality !== undefined) {
				if (patch.quality === "auto") {
					delete next.qualityByChannel[channelId];
				} else {
					next.qualityByChannel[channelId] = patch.quality;
				}
			}
			setSettings(next);
			try {
				if (persist) {
					await persist(next);
				} else if (preferences) {
					await preferences.saveSettings({ player: next });
				} else {
					await updateSettings({ player: next });
				}
			} catch (err) {
				// Roll back optimistic state on a hard failure so the UI shows
				// what the server actually has.
				// eslint-disable-next-line no-console
				console.warn("Failed to persist player settings", err);
				setSettings(settings);
			}
		},
		[channelId, persist, preferences, settings]
	);

	if (!settings) {
		// Keep the route stable while the app-boundary preference load
		// completes; the player owns its loading skeleton once mounted.
		return (
			<div
				data-testid="player-bootstrap"
				className="aspect-video w-full animate-pulse rounded bg-surface-muted"
			/>
		);
	}

	const pinned = settings.qualityByChannel[channelId];
	return (
		<Player
			channelId={channelId}
			isRecording={isRecording}
			onPersist={onPersist}
			onDismiss={onDismiss ?? undefined}
			initial={{
				volume: settings.volume,
				muted: settings.muted,
				captionsEnabled: settings.captionsEnabled,
				quality: pinned ?? "auto"
			}}
		/>
	);
}
