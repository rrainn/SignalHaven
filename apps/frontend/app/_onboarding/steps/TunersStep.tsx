"use client";

import type {
	EventMessage,
	Tuner,
	TunerCreate,
	TunerDiscoveryResult,
	TunerKind
} from "@signalhaven/shared";
import { CheckCircle2, Plus, RefreshCw, Tv } from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type FormEvent
} from "react";

import {
	ApiError,
	createTuner,
	discoverTuners,
	syncTunerChannels
} from "../../../lib/api-client";
import { useWebSocketEvents } from "../../../lib/ws-client";
import { Badge } from "../../_ui/Badge";
import { Button } from "../../_ui/Button";
import { Card, CardContent } from "../../_ui/Card";
import { EmptyState } from "../../_ui/EmptyState";
import { Input } from "../../_ui/Input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "../../_ui/Select";
import { Spinner } from "../../_ui/Spinner";

export type TunersStepProps = {
	/** Pre-existing tuners (so users see what they already configured). */
	existingTuners: Tuner[];
	onTunerCreated: (tuner: Tuner) => void;
	onNext: () => void;
	onBack: () => void;
	onSkip: () => void;
	/**
	 * Optional override of the WS URL — used in tests to point at a fake
	 * server. Production resolves from the same origin.
	 */
	wsUrl?: string;
};

type DiscoveryState =
	| { status: "idle" }
	| { status: "running" }
	| { status: "ready"; results: TunerDiscoveryResult[] }
	| { status: "error"; message: string };

type LineupState =
	| { status: "idle" }
	| { status: "running"; tunerName: string }
	| { status: "success"; channelCount: number }
	| { status: "error"; tuner: Tuner };

/**
 * Tuner discovery + manual-add step.
 *
 * Flow:
 *   1. User clicks "Detect tuners" — POST `/tuners/discover` runs in
 *      the background.
 *   2. While running, the step subscribes to the `tuners` WS topic so any
 *      `discovered`, `created`, `updated`, `deleted` events are reflected
 *      live (e.g. another browser tab could add tuners simultaneously).
 *   3. The user picks a discovered candidate to save, or fills the manual
 *      form (HDHomeRun / IPTV / HLS).
 */
export function TunersStep(props: TunersStepProps) {
	const { existingTuners, onTunerCreated, onNext, onBack, onSkip, wsUrl } =
		props;

	const [discovery, setDiscovery] = useState<DiscoveryState>({
		status: "idle"
	});
	const [savingId, setSavingId] = useState<string | null>(null);
	const [showManual, setShowManual] = useState(false);
	const [lineup, setLineup] = useState<LineupState>({ status: "idle" });

	// Subscribe to live tuner events so discovered candidates / external
	// changes appear without needing to re-poll.
	useWebSocketEvents({
		topics: ["tuners"],
		enabled: true,
		url: wsUrl,
		onEvent: useCallback((event: EventMessage) => {
			if (event.event === "discovered") {
				const data = event.data as { results?: TunerDiscoveryResult[] };
				if (Array.isArray(data?.results)) {
					setDiscovery({ status: "ready", results: data.results });
				}
			}
		}, [])
	});

	const runDiscovery = useCallback(async () => {
		setDiscovery({ status: "running" });
		try {
			const response = await discoverTuners();
			setDiscovery({ status: "ready", results: response.results });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Discovery failed";
			setDiscovery({ status: "error", message });
		}
	}, []);

	/** Import channels immediately so the guide is useful when onboarding ends. */
	const importChannels = useCallback(async (tuner: Tuner) => {
		setLineup({ status: "running", tunerName: tuner.name });
		try {
			const result = await syncTunerChannels(tuner.id);
			setLineup({ status: "success", channelCount: result.total });
		} catch {
			// Keep the newly created tuner and offer a safe retry for transient network failures.
			setLineup({ status: "error", tuner });
		}
	}, []);

	/** Reflect the saved tuner before the potentially slower lineup import begins. */
	const finishTunerCreation = useCallback(
		async (tuner: Tuner) => {
			onTunerCreated(tuner);
			await importChannels(tuner);
		},
		[importChannels, onTunerCreated]
	);

	const handleSaveDiscovered = useCallback(
		async (result: TunerDiscoveryResult) => {
			const key = `${result.kind}:${result.name}`;
			setSavingId(key);
			try {
				const created = await createTuner(result as TunerCreate);
				await finishTunerCreation(created);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Could not save tuner";
				setDiscovery({ status: "error", message });
			} finally {
				setSavingId(null);
			}
		},
		[finishTunerCreation]
	);

	const candidates = useMemo<TunerDiscoveryResult[]>(() => {
		if (discovery.status !== "ready") return [];
		// Hide candidates that map to a tuner already configured (matched by
		// kind + a stable identifier from the config blob).
		const seen = new Set(
			existingTuners.map((t) => `${t.kind}:${stableTunerKey(t.kind, t.config)}`)
		);
		return discovery.results.filter(
			(r) => !seen.has(`${r.kind}:${stableTunerKey(r.kind, r.config)}`)
		);
	}, [discovery, existingTuners]);

	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<p className="text-sm text-secondary">
					SignalHaven streams from network tuners (HDHomeRun) or IPTV / HLS
					playlists. Detect any HDHomeRun devices on your network, or add a
					source manually.
				</p>
			</div>

			{existingTuners.length > 0 ? (
				<ConfiguredTuners tuners={existingTuners} />
			) : null}

			<div className="flex flex-wrap items-center gap-2">
				<Button
					onClick={runDiscovery}
					disabled={discovery.status === "running"}
				>
					{discovery.status === "running" ? (
						<Spinner aria-hidden="true" className="h-4 w-4" />
					) : (
						<RefreshCw aria-hidden="true" className="h-4 w-4" />
					)}
					{discovery.status === "running" ? "Detecting…" : "Detect tuners"}
				</Button>
				<Button
					variant="outline"
					onClick={() => setShowManual((value) => !value)}
				>
					<Plus aria-hidden="true" className="h-4 w-4" />
					{showManual ? "Hide manual form" : "Add manually"}
				</Button>
			</div>

			{discovery.status === "error" ? (
				<p
					role="alert"
					className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
				>
					{discovery.message}
				</p>
			) : null}

			{discovery.status === "running" ? (
				<p
					role="status"
					aria-live="polite"
					className="flex items-center gap-2 text-sm text-secondary"
				>
					<Spinner aria-hidden="true" className="h-4 w-4" />
					Searching your network…
				</p>
			) : null}

			{discovery.status === "ready" ? (
				candidates.length === 0 ? (
					<EmptyState
						icon={<Tv aria-hidden="true" />}
						title={
							existingTuners.length > 0
								? discovery.results.length > 0
									? "All detected tuners are configured"
									: "No additional tuners detected"
								: "No tuners detected"
						}
						description={
							existingTuners.length > 0
								? "Your configured tuner is ready. Continue when you’re finished adding sources."
								: "If your HDHomeRun is on another VLAN, add it by IP. IPTV and HLS sources can also be added manually."
						}
					/>
				) : (
					<ul aria-label="Discovered tuners" className="space-y-2">
						{candidates.map((result) => {
							const key = `${result.kind}:${result.name}`;
							const isSaving = savingId === key;
							return (
								<li key={key}>
									<Card>
										<CardContent className="flex flex-wrap items-center gap-3 pt-4 sm:pt-6">
											<div className="flex-1">
												<p className="font-medium text-primary">
													{result.name}
												</p>
												<p className="text-xs text-secondary">
													<Badge variant="outline" className="mr-2">
														{result.kind.toUpperCase()}
													</Badge>
													{describeConfig(result)}
												</p>
											</div>
											<Button
												size="sm"
												onClick={() => handleSaveDiscovered(result)}
												disabled={isSaving}
											>
												{isSaving ? (
													<Spinner aria-hidden="true" className="h-4 w-4" />
												) : null}
												{isSaving ? "Saving…" : "Add"}
											</Button>
										</CardContent>
									</Card>
								</li>
							);
						})}
					</ul>
				)
			) : null}

			{lineup.status === "running" ? (
				<p
					role="status"
					aria-live="polite"
					className="flex items-center gap-2 text-sm text-secondary"
				>
					<Spinner aria-hidden="true" className="h-4 w-4" />
					Importing channels from {lineup.tunerName}…
				</p>
			) : null}

			{lineup.status === "success" ? (
				<p
					role="status"
					aria-live="polite"
					className="flex items-center gap-2 text-sm text-success"
				>
					<CheckCircle2 aria-hidden="true" className="h-4 w-4" />
					{lineup.channelCount === 1
						? "1 channel imported"
						: `${lineup.channelCount} channels imported`}
				</p>
			) : null}

			{lineup.status === "error" ? (
				<div
					role="alert"
					className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger sm:flex-row sm:items-center"
				>
					<p className="flex-1">
						Tuner added, but its channels could not be imported. Check that it
						is reachable, then retry.
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void importChannels(lineup.tuner)}
						className="border-danger/40"
					>
						Retry import
					</Button>
				</div>
			) : null}

			{showManual ? (
				<ManualTunerForm
					onCreated={async (tuner) => {
						await finishTunerCreation(tuner);
						setShowManual(false);
					}}
				/>
			) : null}

			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
				<Button variant="ghost" onClick={onBack}>
					Back
				</Button>
				<Button
					onClick={existingTuners.length > 0 ? onNext : onSkip}
					disabled={lineup.status === "running"}
				>
					{existingTuners.length > 0 ? "Continue" : "Set up later"}
				</Button>
			</div>
		</div>
	);
}

function ConfiguredTuners({ tuners }: { tuners: Tuner[] }) {
	return (
		<div className="rounded-lg border border-border bg-surface-muted/50 p-3 text-sm">
			<p className="mb-2 font-medium text-primary">
				Already configured ({tuners.length})
			</p>
			<ul className="space-y-1 text-secondary">
				{tuners.map((tuner) => (
					<li key={tuner.id} className="flex items-center gap-2">
						<Badge variant="outline">{tuner.kind.toUpperCase()}</Badge>
						<span>{tuner.name}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

type ManualTunerFormProps = {
	onCreated: (tuner: Tuner) => Promise<void> | void;
};

function ManualTunerForm({ onCreated }: ManualTunerFormProps) {
	const [kind, setKind] = useState<TunerKind>("hdhomerun");
	const [name, setName] = useState("");
	const [field1, setField1] = useState("");
	const [field2, setField2] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);

			let body: TunerCreate;
			try {
				body = buildManualTunerBody(kind, name, field1, field2);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Invalid input");
				return;
			}

			setSubmitting(true);
			try {
				const created = await createTuner(body);
				await onCreated(created);
				setName("");
				setField1("");
				setField2("");
			} catch (err) {
				if (err instanceof ApiError) {
					setError(`${err.message}`);
				} else {
					setError(err instanceof Error ? err.message : "Could not save");
				}
			} finally {
				setSubmitting(false);
			}
		},
		[field1, field2, kind, name, onCreated]
	);

	// Reset volatile fields when switching kinds so labels match the input.
	useEffect(() => {
		setField1("");
		setField2("");
	}, [kind]);

	const labels = MANUAL_FIELD_LABELS[kind];

	return (
		<form
			onSubmit={onSubmit}
			aria-label="Add tuner manually"
			className="space-y-3 rounded-lg border border-border bg-surface p-4"
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="space-y-1 text-sm">
					<span className="text-primary">Kind</span>
					<Select
						value={kind}
						onValueChange={(value) => setKind(value as TunerKind)}
					>
						<SelectTrigger aria-label="Tuner kind">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="hdhomerun">HDHomeRun</SelectItem>
							<SelectItem value="iptv">IPTV (M3U)</SelectItem>
							<SelectItem value="hls">HLS stream</SelectItem>
						</SelectContent>
					</Select>
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-primary">Name</span>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="My HDHomeRun"
						required
					/>
				</label>
				<label className="space-y-1 text-sm sm:col-span-2">
					<span className="text-primary">{labels.field1}</span>
					<Input
						value={field1}
						onChange={(e) => setField1(e.target.value)}
						placeholder={labels.field1Placeholder}
						required
					/>
				</label>
				{labels.field2 ? (
					<label className="space-y-1 text-sm sm:col-span-2">
						<span className="text-primary">{labels.field2}</span>
						<Input
							value={field2}
							onChange={(e) => setField2(e.target.value)}
							placeholder={labels.field2Placeholder}
						/>
					</label>
				) : null}
			</div>

			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}

			<div className="flex justify-end">
				<Button type="submit" disabled={submitting}>
					{submitting ? (
						<Spinner aria-hidden="true" className="h-4 w-4" />
					) : null}
					{submitting ? "Saving…" : "Save tuner"}
				</Button>
			</div>
		</form>
	);
}

const MANUAL_FIELD_LABELS: Record<
	TunerKind,
	{
		field1: string;
		field1Placeholder: string;
		field2?: string;
		field2Placeholder?: string;
	}
> = {
	hdhomerun: {
		field1: "Host or IP",
		field1Placeholder: "192.168.1.50"
	},
	iptv: {
		field1: "Playlist URL",
		field1Placeholder: "https://example.com/playlist.m3u",
		field2: "EPG URL (optional)",
		field2Placeholder: "https://example.com/guide.xml"
	},
	hls: {
		field1: "Stream URL",
		field1Placeholder: "https://example.com/master.m3u8",
		field2: "Channel name (optional)",
		field2Placeholder: "Channel 1"
	}
};

function buildManualTunerBody(
	kind: TunerKind,
	name: string,
	field1: string,
	field2: string
): TunerCreate {
	const trimmedName = name.trim();
	if (!trimmedName) {
		throw new Error("Name is required");
	}
	if (!field1.trim()) {
		throw new Error("This field is required");
	}
	if (kind === "hdhomerun") {
		return {
			kind: "hdhomerun",
			name: trimmedName,
			config: { host: field1.trim() }
		};
	}
	if (kind === "iptv") {
		const config: { url: string; epgUrl?: string } = { url: field1.trim() };
		if (field2.trim()) config.epgUrl = field2.trim();
		return { kind: "iptv", name: trimmedName, config };
	}
	// hls
	const config: { url: string; channelName?: string } = { url: field1.trim() };
	if (field2.trim()) config.channelName = field2.trim();
	return { kind: "hls", name: trimmedName, config };
}

function describeConfig(result: TunerDiscoveryResult): string {
	switch (result.kind) {
		case "hdhomerun":
			return result.config.deviceId
				? `${result.config.host} (${result.config.deviceId})`
				: result.config.host;
		case "iptv":
			return result.config.url;
		case "hls":
			return result.config.url;
	}
}

function stableTunerKey(
	kind: string,
	config: Record<string, unknown> | unknown
): string {
	if (!config || typeof config !== "object") return "";
	const c = config as Record<string, unknown>;
	if (kind === "hdhomerun") {
		return String(c["deviceId"] ?? c["host"] ?? "");
	}
	return String(c["url"] ?? "");
}
