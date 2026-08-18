"use client";

import {
	uiSettingsSchema,
	type Density,
	type UserPreferences,
	type UserPreferencesPatch
} from "@signalhaven/shared";
import { CircleCheck } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { updatePreferences } from "../../lib/api-client";
import { useAdvancedModeOptional } from "../_advanced/AdvancedModeProvider";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { Input } from "../_ui/Input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "../_ui/Select";
import { Spinner } from "../_ui/Spinner";
import { Switch } from "../_ui/Switch";
import { useTheme } from "../_theme/ThemeProvider";
import { THEME_MODES, type ThemeMode } from "../_theme/theme";

import { applyAppearance, persistAppearance } from "./appearance";
import { formatErrorMessage, formatIssue } from "./form-helpers";

export type AppearanceSectionProps = {
	preferences: UserPreferences["ui"];
	onChanged: (next: UserPreferences) => void;
	/** Diagnostics are an administrator capability, not a personal preference. */
	showAdvancedMode?: boolean;
	/** App-owned persistence path; isolated tests fall back to the API client. */
	savePreferences?: (patch: UserPreferencesPatch) => Promise<UserPreferences>;
};

const THEME_LABELS: Record<ThemeMode, string> = {
	light: "Light",
	dark: "Dark",
	system: "System"
};

const DENSITY_LABELS: Record<Density, string> = {
	comfortable: "Comfortable",
	compact: "Compact"
};

/**
 * Account preference form for appearance and guide presentation:
 * theme, density, and animations on/off.
 *
 * Theme persistence is shared with the existing `useTheme()` hook so the
 * `themeBootstrapScript` continues to prevent flash-of-wrong-theme on
 * reload. Density and animations are mirrored to `localStorage` for
 * instant application + persisted via `PATCH /api/v1/preferences` for
 * cross-device sync; both are validated against `uiSettingsSchema`
 * client-side.
 */
export function AppearanceSection(props: AppearanceSectionProps) {
	const { preferences, onChanged } = props;
	const { mode: themeMode, setMode: setThemeMode } = useTheme();
	const advancedMode = useAdvancedModeOptional();

	const [density, setDensity] = useState<Density>(preferences.density);
	const [animations, setAnimations] = useState<boolean>(preferences.animations);
	const [epgHoursVisible, setEpgHoursVisible] = useState(
		String(preferences.epgHoursVisible)
	);
	const [use24HourClock, setUse24HourClock] = useState(
		preferences.use24HourClock
	);
	const [submitting, setSubmitting] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<string | null>(null);

	useEffect(() => {
		if (dirty || submitting) return;
		setDensity(preferences.density);
		setAnimations(preferences.animations);
		setEpgHoursVisible(String(preferences.epgHoursVisible));
		setUse24HourClock(preferences.use24HourClock);
		setThemeMode(preferences.theme);
	}, [dirty, preferences, setThemeMode, submitting]);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			setSavedAt(null);

			const candidate = {
				theme: themeMode,
				epgHoursVisible: Number(epgHoursVisible),
				use24HourClock,
				density,
				animations
			};
			const parsed = uiSettingsSchema.safeParse(candidate);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				setError(first ? formatIssue(first) : "Invalid input");
				return;
			}

			setSubmitting(true);
			try {
				const save = props.savePreferences ?? updatePreferences;
				const next = await save({ ui: parsed.data });
				onChanged(next);
				setDirty(false);
				// Apply + persist locally so the next reload picks up the new
				// density / animation choice without waiting for the network.
				applyAppearance({ density, animations });
				persistAppearance({ density, animations });
				setSavedAt(new Date().toISOString());
			} catch (err) {
				setError(formatErrorMessage(err, "Could not save"));
			} finally {
				setSubmitting(false);
			}
		},
		[
			animations,
			density,
			epgHoursVisible,
			onChanged,
			props.savePreferences,
			themeMode,
			use24HourClock
		]
	);

	return (
		<form
			noValidate
			onSubmit={onSubmit}
			aria-label="Appearance settings"
			className="space-y-4"
			data-testid="appearance-section"
		>
			<Card>
				<CardHeader>
					<CardTitle>Appearance</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium text-primary">Theme</legend>
						<div
							role="group"
							aria-label="Theme"
							className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted p-1 text-xs"
						>
							{THEME_MODES.map((m) => {
								const active = themeMode === m;
								return (
									<button
										key={m}
										type="button"
										aria-pressed={active}
										data-testid={`appearance-theme-${m}`}
										onClick={() => {
											setDirty(true);
											setThemeMode(m);
										}}
										className={
											"rounded-full px-3 py-1 transition-colors " +
											(active
												? "bg-accent text-accent-foreground"
												: "text-secondary hover:text-primary")
										}
									>
										{THEME_LABELS[m]}
									</button>
								);
							})}
						</div>
					</fieldset>

					<label className="block space-y-1 text-sm">
						<span className="text-primary">Density</span>
						<Select
							value={density}
							onValueChange={(value) => {
								const next = value as Density;
								setDensity(next);
								setDirty(true);
								applyAppearance({ density: next, animations });
							}}
						>
							<SelectTrigger aria-label="Density">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(Object.keys(DENSITY_LABELS) as Density[]).map((d) => (
									<SelectItem key={d} value={d}>
										{DENSITY_LABELS[d]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>

					<label className="flex items-center justify-between gap-2 text-sm">
						<span className="text-primary">Animations</span>
						<Switch
							checked={animations}
							onCheckedChange={(value: boolean) => {
								setAnimations(value);
								setDirty(true);
								applyAppearance({ density, animations: value });
							}}
							aria-label="Animations"
							data-testid="appearance-animations"
						/>
					</label>

					<label className="block space-y-1 text-sm">
						<span className="text-primary">Guide hours visible</span>
						<span className="block text-xs text-secondary">
							Sets the Guide&apos;s requested and rendered time horizon from its
							current start.
						</span>
						<Input
							type="number"
							min={1}
							max={24}
							value={epgHoursVisible}
							onChange={(e) => {
								setDirty(true);
								setEpgHoursVisible(e.target.value);
							}}
						/>
					</label>

					<label className="flex items-center justify-between gap-2 text-sm">
						<span className="text-primary">24-hour clock</span>
						<Switch
							checked={use24HourClock}
							onCheckedChange={(value: boolean) => {
								setDirty(true);
								setUse24HourClock(value);
							}}
							aria-label="24-hour clock"
						/>
					</label>
				</CardContent>
			</Card>

			{props.showAdvancedMode !== false ? (
				<Card>
					<CardHeader>
						<CardTitle>Advanced mode</CardTitle>
					</CardHeader>
					<CardContent>
						<label className="flex items-start justify-between gap-4 text-sm">
							<span className="space-y-1">
								<span className="block text-primary">Enable advanced mode</span>
								<span className="block text-xs text-secondary">
									Adds FFmpeg controls, HDHomeRun signal quality, detailed
									playback statistics, and diagnostic error details on this
									browser.
								</span>
							</span>
							<Switch
								checked={advancedMode?.enabled ?? false}
								onCheckedChange={(enabled) => advancedMode?.setEnabled(enabled)}
								aria-label="Advanced mode"
								data-testid="advanced-mode-toggle"
							/>
						</label>
					</CardContent>
				</Card>
			) : null}

			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}
			{savedAt && !error ? (
				<p
					role="status"
					className="flex items-center gap-2 text-sm text-primary"
				>
					<CircleCheck aria-hidden="true" className="h-4 w-4 text-accent" />
					Saved.
				</p>
			) : null}

			<div className="flex justify-end">
				<Button type="submit" disabled={submitting}>
					{submitting ? (
						<Spinner aria-hidden="true" className="h-4 w-4" />
					) : null}
					{submitting ? "Saving…" : "Save"}
				</Button>
			</div>
		</form>
	);
}
