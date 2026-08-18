"use client";

import {
	transcodingSettingsSchema,
	transcodeProfileSchema,
	type ChannelListItem,
	type PlayerSettings,
	type Settings,
	type TranscodeProfile,
	type UserPreferences,
	type UserPreferencesPatch
} from "@signalhaven/shared";
import { Trash2 } from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type FormEvent
} from "react";

import {
	listChannels,
	updatePreferences,
	updateSettings
} from "../../lib/api-client";
import { Badge } from "../_ui/Badge";
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

import { formatErrorMessage, formatIssue } from "./form-helpers";

export type TranscodingSectionProps = {
	settings: Settings;
	playerPreferences: PlayerSettings;
	onChanged: (next: Settings) => void;
	onPlayerPreferencesChanged?: (next: UserPreferences) => void;
	savePreferences?: (patch: UserPreferencesPatch) => Promise<UserPreferences>;
};

const PROFILE_VALUES = transcodeProfileSchema.options;
/** Match the Channels page so large lineups have predictable initial DOM work. */
const CHANNEL_OVERRIDE_RENDER_BATCH_SIZE = 100;
const HWACCEL_OPTIONS = [
	"auto",
	"none",
	"videotoolbox",
	"vaapi",
	"qsv",
	"nvenc"
] as const;

/**
 * Settings section for transcoding (rrainn/SignalHaven#U11-settings):
 * default profile, hwaccel override, and per-channel profile overrides
 * (mirrored to `player.qualityByChannel` so the U6 player respects the
 * pin without further wiring).
 */
export function TranscodingSection(props: TranscodingSectionProps) {
	const { settings, playerPreferences, onChanged } = props;
	const t = settings.transcoding;
	const [enabled, setEnabled] = useState(t.enabled);
	const [defaultProfile, setDefaultProfile] = useState<TranscodeProfile>(
		t.defaultProfile
	);
	const [hwaccel, setHwaccel] = useState<string>(t.hwaccel);
	const [videoBitrate, setVideoBitrate] = useState(String(t.videoBitrateKbps));
	const [audioBitrate, setAudioBitrate] = useState(String(t.audioBitrateKbps));
	const [captionsEnabled, setCaptionsEnabled] = useState(t.captionsEnabled);
	const [overrides, setOverrides] = useState<Record<string, TranscodeProfile>>(
		playerPreferences.qualityByChannel
	);
	const [channels, setChannels] = useState<ChannelListItem[]>([]);
	const [channelRenderLimit, setChannelRenderLimit] = useState(
		CHANNEL_OVERRIDE_RENDER_BATCH_SIZE
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<string | null>(null);

	// Load channels for the per-channel override picker. Best-effort:
	// failures just leave the picker empty.
	useEffect(() => {
		let cancelled = false;
		void listChannels()
			.then((res) => {
				if (!cancelled) {
					setChannels(res.items);
					setChannelRenderLimit(CHANNEL_OVERRIDE_RENDER_BATCH_SIZE);
				}
			})
			.catch(() => {
				/* ignore — UI degrades gracefully */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const renderedChannels = useMemo(
		() => channels.slice(0, channelRenderLimit),
		[channelRenderLimit, channels]
	);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			setSavedAt(null);

			const candidate = {
				enabled,
				preset: t.preset,
				videoBitrateKbps: Number(videoBitrate),
				audioBitrateKbps: Number(audioBitrate),
				defaultProfile,
				hwaccel,
				// Runtime capability probes own this backend-generated list, so the
				// settings form preserves it as read-only state.
				availableHwaccels: t.availableHwaccels,
				captionsEnabled
			};
			const parsed = transcodingSettingsSchema.safeParse(candidate);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				setError(first ? formatIssue(first) : "Invalid input");
				return;
			}

			setSubmitting(true);
			try {
				const next = await updateSettings({ transcoding: parsed.data });
				const savePreferences = props.savePreferences ?? updatePreferences;
				const nextPreferences = await savePreferences({
					player: { ...playerPreferences, qualityByChannel: overrides }
				});
				onChanged(next);
				props.onPlayerPreferencesChanged?.(nextPreferences);
				setSavedAt(new Date().toISOString());
			} catch (err) {
				setError(formatErrorMessage(err, "Could not save"));
			} finally {
				setSubmitting(false);
			}
		},
		[
			audioBitrate,
			captionsEnabled,
			defaultProfile,
			enabled,
			hwaccel,
			onChanged,
			overrides,
			playerPreferences,
			props,
			t.availableHwaccels,
			t.preset,
			videoBitrate
		]
	);

	const setOverride = useCallback(
		(channelId: string, profile: TranscodeProfile | "") => {
			setOverrides((prev) => {
				const next = { ...prev };
				if (profile === "") {
					delete next[channelId];
				} else {
					next[channelId] = profile;
				}
				return next;
			});
		},
		[]
	);

	return (
		<form
			noValidate
			onSubmit={onSubmit}
			aria-label="Transcoding settings"
			className="space-y-4"
		>
			<Card>
				<CardHeader>
					<CardTitle>Transcoding defaults</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<label className="flex items-center justify-between gap-2 text-sm">
						<span className="text-primary">Enable transcoding pipeline</span>
						<Switch
							checked={enabled}
							onCheckedChange={(value: boolean) => setEnabled(value)}
							aria-label="Enable transcoding"
						/>
					</label>

					<label className="block space-y-1 text-sm">
						<span className="text-primary">Default profile</span>
						<Select
							value={defaultProfile}
							onValueChange={(value) =>
								setDefaultProfile(value as TranscodeProfile)
							}
						>
							<SelectTrigger aria-label="Default profile">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PROFILE_VALUES.map((p) => (
									<SelectItem key={p} value={p}>
										{p}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>

					<label className="block space-y-1 text-sm">
						<span className="text-primary">Hardware acceleration</span>
						<Select
							value={hwaccel}
							onValueChange={(value) => setHwaccel(value)}
						>
							<SelectTrigger aria-label="Hardware acceleration">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{HWACCEL_OPTIONS.map((h) => (
									<SelectItem key={h} value={h}>
										{h}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{t.availableHwaccels.length > 0 ? (
							<span className="block text-xs text-muted">
								Detected: {t.availableHwaccels.join(", ")}
							</span>
						) : (
							<span className="block text-xs text-muted">
								No hardware acceleration detected on this host.
							</span>
						)}
					</label>

					<div className="grid gap-3 sm:grid-cols-2">
						<label className="space-y-1 text-sm">
							<span className="text-primary">Video bitrate (kbps)</span>
							<Input
								type="number"
								min={1}
								max={100000}
								value={videoBitrate}
								onChange={(e) => setVideoBitrate(e.target.value)}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="text-primary">Audio bitrate (kbps)</span>
							<Input
								type="number"
								min={1}
								max={1024}
								value={audioBitrate}
								onChange={(e) => setAudioBitrate(e.target.value)}
							/>
						</label>
					</div>

					<label className="flex items-center justify-between gap-2 text-sm">
						<span className="text-primary">Extract closed captions</span>
						<Switch
							checked={captionsEnabled}
							onCheckedChange={(value: boolean) => setCaptionsEnabled(value)}
							aria-label="Captions extraction"
						/>
					</label>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Per-channel profile overrides</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{channels.length === 0 ? (
						<p className="text-sm text-secondary">
							No channels configured yet. Per-channel overrides become available
							once channels are imported from a tuner.
						</p>
					) : (
						<ul aria-label="Per-channel overrides" className="space-y-2">
							{renderedChannels.map((c) => {
								const value = overrides[c.id] ?? "";
								return (
									<li
										key={c.id}
										className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2"
									>
										<div className="flex-1">
											<p className="text-sm text-primary">
												{c.number} · {c.name}
											</p>
											<Badge variant="outline">
												{c.tunerKind?.toUpperCase() ?? "CHANNEL"}
											</Badge>
										</div>
										<Select
											value={value || "__default__"}
											onValueChange={(v) =>
												setOverride(
													c.id,
													v === "__default__" ? "" : (v as TranscodeProfile)
												)
											}
										>
											<SelectTrigger
												aria-label={`Profile override for ${c.name}`}
												className="w-44"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="__default__">Use default</SelectItem>
												{PROFILE_VALUES.map((p) => (
													<SelectItem key={p} value={p}>
														{p}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										{value ? (
											<Button
												type="button"
												size="sm"
												variant="ghost"
												onClick={() => setOverride(c.id, "")}
												aria-label={`Clear override for ${c.name}`}
											>
												<Trash2 aria-hidden="true" className="h-4 w-4" />
											</Button>
										) : null}
									</li>
								);
							})}
						</ul>
					)}
					{channels.length > 0 ? (
						<div className="flex flex-col items-center gap-2">
							<p
								className="text-xs text-secondary"
								data-testid="transcoding-channels-summary"
								aria-live="polite"
							>
								Showing {renderedChannels.length.toLocaleString()} of{" "}
								{channels.length.toLocaleString()} channels
							</p>
							{renderedChannels.length < channels.length ? (
								<Button
									type="button"
									variant="secondary"
									data-testid="transcoding-channels-load-more"
									onClick={() =>
										setChannelRenderLimit((current) =>
											Math.min(
												current + CHANNEL_OVERRIDE_RENDER_BATCH_SIZE,
												channels.length
											)
										)
									}
								>
									Show more channels
								</Button>
							) : null}
						</div>
					) : null}
				</CardContent>
			</Card>

			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}
			{savedAt && !error ? (
				<p role="status" className="text-sm text-success">
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
