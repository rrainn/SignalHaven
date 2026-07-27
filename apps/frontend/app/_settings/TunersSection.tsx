"use client";

import {
	lineupSyncSettingsSchema,
	tunerCreateSchema,
	type EventMessage,
	type Settings,
	type Tuner,
	type TunerCreate,
	type TunerKind
} from "@signalhaven/shared";
import { Download, Pencil, Plus, RefreshCw, Trash2, Tv } from "lucide-react";
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
	deleteTuner,
	discoverTuners,
	getTunerStatus,
	syncTunerChannels,
	updateSettings,
	updateTuner
} from "../../lib/api-client";
import { useWebSocketEvents } from "../../lib/ws-client";
import { Badge } from "../_ui/Badge";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { EmptyState } from "../_ui/EmptyState";
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

import { formatErrorMessage } from "./form-helpers";

export type TunersSectionProps = {
	tuners: Tuner[];
	onChanged: () => Promise<void> | void;
	settings?: Settings;
	onSettingsChanged?: (next: Settings) => void;
};

type DiscoveryState =
	| { status: "idle" }
	| { status: "running" }
	| { status: "ready"; results: TunerCreate[] }
	| { status: "error"; message: string };

type StatusState = {
	online: boolean;
	message?: string;
	checkedAt: string;
};

/**
 * Settings section for managing tuners (rrainn/SignalHaven#U11-settings).
 *
 * Renders the existing tuners with an inline online/offline status badge
 * (polled from `GET /api/v1/tuners/:id/status`, refreshed when the
 * `tuners` WS topic emits `lease.*` events) and offers add / discover /
 * delete actions. The shared `tunerCreateSchema` is used for client-side
 * form validation so users get inline errors before the server roundtrip.
 */
export function TunersSection(props: TunersSectionProps) {
	const { tuners, onChanged, settings, onSettingsChanged } = props;

	const [statuses, setStatuses] = useState<Record<string, StatusState>>({});
	const [refreshingStatusId, setRefreshingStatusId] = useState<string | null>(
		null
	);
	const [discovery, setDiscovery] = useState<DiscoveryState>({
		status: "idle"
	});
	const [savingDiscoveredKey, setSavingDiscoveredKey] = useState<string | null>(
		null
	);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [syncingId, setSyncingId] = useState<string | null>(null);
	const [syncResults, setSyncResults] = useState<
		Record<
			string,
			{
				added: number;
				updated: number;
				removed: number;
				missing: number;
				total: number;
			}
		>
	>({});
	const [showManual, setShowManual] = useState(false);
	// Keep the larger policy form out of the initial Settings paint.
	const [showSyncPolicy, setShowSyncPolicy] = useState(false);

	const refreshStatus = useCallback(async (id: string) => {
		setRefreshingStatusId(id);
		try {
			const status = await getTunerStatus(id);
			setStatuses((prev) => {
				const next: Record<string, StatusState> = { ...prev };
				const value: StatusState = {
					online: status.online,
					checkedAt: status.checkedAt
				};
				if (status.message !== undefined) value.message = status.message;
				next[id] = value;
				return next;
			});
		} catch (err) {
			setStatuses((prev) => ({
				...prev,
				[id]: {
					online: false,
					message: err instanceof Error ? err.message : "Status check failed",
					checkedAt: new Date().toISOString()
				}
			}));
		} finally {
			setRefreshingStatusId((curr) => (curr === id ? null : curr));
		}
	}, []);

	// Refresh status for every tuner once when the list changes.
	useEffect(() => {
		for (const tuner of tuners) {
			void refreshStatus(tuner.id);
		}
	}, [tuners, refreshStatus]);

	// Subscribe to live tuner events for the discovery list and to
	// re-check status when leases change (in-use ↔ idle transitions
	// sometimes correlate with reachability changes too).
	useWebSocketEvents({
		topics: ["tuners"],
		enabled: true,
		onEvent: useCallback(
			(event: EventMessage) => {
				if (event.event === "discovered") {
					const data = event.data as { results?: TunerCreate[] };
					if (Array.isArray(data?.results)) {
						setDiscovery({ status: "ready", results: data.results });
					}
					return;
				}
				if (
					event.event === "lineup.synced" ||
					event.event === "lineup.failed"
				) {
					void onChanged();
					return;
				}
				if (
					event.event === "lease.acquired" ||
					event.event === "lease.released" ||
					event.event === "lease.preempted"
				) {
					const data = event.data as { providerId?: string };
					if (typeof data?.providerId === "string") {
						void refreshStatus(data.providerId);
					}
				}
			},
			[onChanged, refreshStatus]
		)
	});

	const runDiscovery = useCallback(async () => {
		setDiscovery({ status: "running" });
		try {
			const response = await discoverTuners();
			setDiscovery({
				status: "ready",
				results: response.results as TunerCreate[]
			});
		} catch (err) {
			setDiscovery({
				status: "error",
				message: err instanceof Error ? err.message : "Discovery failed"
			});
		}
	}, []);

	const handleSaveDiscovered = useCallback(
		async (candidate: TunerCreate) => {
			const key = `${candidate.kind}:${candidate.name}`;
			setSavingDiscoveredKey(key);
			try {
				await createTuner(candidate);
				await onChanged();
			} catch (err) {
				setDiscovery({
					status: "error",
					message: formatErrorMessage(err, "Could not save tuner")
				});
			} finally {
				setSavingDiscoveredKey((curr) => (curr === key ? null : curr));
			}
		},
		[onChanged]
	);

	const handleDelete = useCallback(
		async (tuner: Tuner) => {
			setDeletingId(tuner.id);
			try {
				await deleteTuner(tuner.id);
				await onChanged();
			} catch (err) {
				setStatuses((prev) => ({
					...prev,
					[tuner.id]: {
						online: prev[tuner.id]?.online ?? false,
						message: formatErrorMessage(err, "Delete failed"),
						checkedAt: new Date().toISOString()
					}
				}));
			} finally {
				setDeletingId((curr) => (curr === tuner.id ? null : curr));
			}
		},
		[onChanged]
	);

	/**
	 * Sync a single tuner's channel lineup into the DB. On success, triggers
	 * `onChanged` so the parent page can re-fetch the channels list, and stores
	 * the result counts for the inline summary badge.
	 */
	const handleSync = useCallback(
		async (tuner: Tuner) => {
			setSyncingId(tuner.id);
			try {
				const result = await syncTunerChannels(tuner.id);
				setSyncResults((prev) => ({ ...prev, [tuner.id]: result }));
				// Notify parent so Channels page refreshes its list.
				await onChanged();
			} catch (err) {
				setStatuses((prev) => ({
					...prev,
					[tuner.id]: {
						online: prev[tuner.id]?.online ?? false,
						message: formatErrorMessage(err, "Sync failed"),
						checkedAt: new Date().toISOString()
					}
				}));
			} finally {
				setSyncingId((curr) => (curr === tuner.id ? null : curr));
			}
		},
		[onChanged]
	);

	const candidates = useMemo<TunerCreate[]>(() => {
		if (discovery.status !== "ready") return [];
		const seen = new Set(
			tuners.map((t) => `${t.kind}:${stableTunerKey(t.kind, t.config)}`)
		);
		return discovery.results.filter(
			(r) => !seen.has(`${r.kind}:${stableTunerKey(r.kind, r.config)}`)
		);
	}, [discovery, tuners]);

	return (
		<div className="space-y-4">
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
					{showManual ? "Hide add form" : "Add tuner"}
				</Button>
				{settings && onSettingsChanged ? (
					<Button
						variant="outline"
						onClick={() => setShowSyncPolicy((visible) => !visible)}
						aria-expanded={showSyncPolicy}
					>
						{showSyncPolicy ? "Hide automatic imports" : "Automatic imports"}
					</Button>
				) : null}
			</div>

			{showSyncPolicy && settings && onSettingsChanged ? (
				<AutomaticLineupSyncSettings
					settings={settings}
					onChanged={onSettingsChanged}
				/>
			) : null}

			{discovery.status === "error" ? (
				<p
					role="alert"
					className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
				>
					{discovery.message}
				</p>
			) : null}

			{showManual ? (
				<ManualTunerForm
					onCreated={async () => {
						setShowManual(false);
						await onChanged();
					}}
				/>
			) : null}

			{discovery.status === "ready" && candidates.length > 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>Discovered tuners</CardTitle>
					</CardHeader>
					<CardContent>
						<ul aria-label="Discovered tuners" className="space-y-2">
							{candidates.map((candidate) => {
								const key = `${candidate.kind}:${candidate.name}`;
								const isSaving = savingDiscoveredKey === key;
								return (
									<li
										key={key}
										className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
									>
										<div className="flex-1">
											<p className="font-medium text-primary">
												{candidate.name}
											</p>
											<p className="text-xs text-secondary">
												<Badge variant="outline" className="mr-2">
													{candidate.kind.toUpperCase()}
												</Badge>
												{describeConfig(candidate)}
											</p>
										</div>
										<Button
											size="sm"
											onClick={() => handleSaveDiscovered(candidate)}
											disabled={isSaving}
										>
											{isSaving ? (
												<Spinner aria-hidden="true" className="h-4 w-4" />
											) : null}
											{isSaving ? "Saving…" : "Add"}
										</Button>
									</li>
								);
							})}
						</ul>
					</CardContent>
				</Card>
			) : null}

			{tuners.length === 0 ? (
				<EmptyState
					icon={<Tv aria-hidden="true" />}
					title="No tuners configured"
					description="Detect HDHomeRun devices on your network or add an IPTV / HLS source manually."
				/>
			) : (
				<ul aria-label="Configured tuners" className="space-y-2">
					{tuners.map((tuner) => {
						const status = statuses[tuner.id];
						const refreshing = refreshingStatusId === tuner.id;
						return (
							<li key={tuner.id}>
								<Card>
									<CardContent className="flex flex-wrap items-center gap-3 pt-4 sm:pt-6">
										<div className="flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<p className="font-medium text-primary">{tuner.name}</p>
												<Badge variant="outline">
													{tuner.kind.toUpperCase()}
												</Badge>
												<TunerStatusBadge
													refreshing={refreshing}
													status={status}
												/>
											</div>
											<p className="text-xs text-secondary">
												{describeStoredConfig(tuner)}
											</p>
											{syncResults[tuner.id] !== undefined ? (
												<p className="text-xs text-secondary">
													Last sync — {syncResults[tuner.id]!.total} channel
													{syncResults[tuner.id]!.total !== 1 ? "s" : ""} (
													{syncResults[tuner.id]!.added} added,{" "}
													{syncResults[tuner.id]!.updated} updated,{" "}
													{syncResults[tuner.id]!.removed} removed)
													{syncResults[tuner.id]!.missing > 0
														? `, ${syncResults[tuner.id]!.missing} awaiting confirmation`
														: ""}
												</p>
											) : tuner.lastLineupSyncAt ? (
												<p className="text-xs text-secondary">
													Automatic sync{" "}
													{tuner.lastLineupSyncStatus === "error"
														? "failed"
														: "completed"}{" "}
													{new Date(tuner.lastLineupSyncAt).toLocaleString()}
													{tuner.lastLineupSyncError
														? ` — ${tuner.lastLineupSyncError}`
														: ""}
												</p>
											) : null}
										</div>
										<div className="flex items-center gap-1">
											<Button
												size="sm"
												variant="ghost"
												onClick={() => {
													setShowManual(false);
													setEditingId((current) =>
														current === tuner.id ? null : tuner.id
													);
												}}
												aria-label={`Edit ${tuner.name}`}
												aria-expanded={editingId === tuner.id}
											>
												<Pencil aria-hidden="true" className="h-4 w-4" />
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => void handleSync(tuner)}
												aria-label={`Sync channels for ${tuner.name}`}
												disabled={syncingId === tuner.id}
												title="Import channels from this tuner"
											>
												{syncingId === tuner.id ? (
													<Spinner aria-hidden="true" className="h-4 w-4" />
												) : (
													<Download aria-hidden="true" className="h-4 w-4" />
												)}
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => void refreshStatus(tuner.id)}
												aria-label={`Recheck ${tuner.name}`}
												disabled={refreshing}
											>
												<RefreshCw aria-hidden="true" className="h-4 w-4" />
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => void handleDelete(tuner)}
												aria-label={`Remove ${tuner.name}`}
												disabled={deletingId === tuner.id}
											>
												<Trash2 aria-hidden="true" className="h-4 w-4" />
											</Button>
										</div>
										{editingId === tuner.id ? (
											<EditTunerForm
												tuner={tuner}
												onCancel={() => setEditingId(null)}
												onSaved={async () => {
													setEditingId(null);
													await onChanged();
												}}
											/>
										) : null}
									</CardContent>
								</Card>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/** Lets operators tune the safe automatic lineup-import cadence. */
function AutomaticLineupSyncSettings(props: {
	settings: Settings;
	onChanged: (next: Settings) => void;
}) {
	const configured = props.settings.lineupSync ?? {
		enabled: true,
		intervalHours: 24,
		removalThreshold: 3
	};
	const [enabled, setEnabled] = useState(configured.enabled);
	const [intervalHours, setIntervalHours] = useState(
		String(configured.intervalHours)
	);
	const [removalThreshold, setRemovalThreshold] = useState(
		String(configured.removalThreshold)
	);
	const [submitting, setSubmitting] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setMessage(null);
			const parsed = lineupSyncSettingsSchema.safeParse({
				enabled,
				intervalHours: Number(intervalHours),
				removalThreshold: Number(removalThreshold)
			});
			if (!parsed.success) {
				setMessage(parsed.error.issues[0]?.message ?? "Invalid sync policy");
				return;
			}
			setSubmitting(true);
			try {
				const next = await updateSettings({ lineupSync: parsed.data });
				props.onChanged(next);
				setMessage("Automatic channel imports saved.");
			} catch (error) {
				setMessage(formatErrorMessage(error, "Could not save sync policy"));
			} finally {
				setSubmitting(false);
			}
		},
		[enabled, intervalHours, props, removalThreshold]
	);

	return (
		<form
			onSubmit={onSubmit}
			className="space-y-3"
			aria-label="Automatic channel imports"
		>
			<Card>
				<CardHeader>
					<CardTitle>Automatic channel imports</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<label className="flex items-center justify-between gap-3 text-sm">
						<span>Refresh tuner lineups automatically</span>
						<Switch checked={enabled} onCheckedChange={setEnabled} />
					</label>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="space-y-1 text-sm">
							<span>Refresh every (hours)</span>
							<Input
								type="number"
								min={1}
								max={168}
								value={intervalHours}
								onChange={(event) => setIntervalHours(event.target.value)}
								disabled={!enabled}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span>Remove after consecutive misses</span>
							<Input
								type="number"
								min={2}
								max={10}
								value={removalThreshold}
								onChange={(event) => setRemovalThreshold(event.target.value)}
							/>
						</label>
					</div>
					<p className="text-xs text-secondary">
						Failed refreshes never remove channels. A missing channel is deleted
						only after this many successful imports omit it.
					</p>
					<div className="flex items-center gap-3">
						<Button type="submit" size="sm" disabled={submitting}>
							{submitting ? (
								<Spinner aria-hidden="true" className="h-4 w-4" />
							) : null}
							Save import policy
						</Button>
						{message ? (
							<p role="status" className="text-xs text-secondary">
								{message}
							</p>
						) : null}
					</div>
				</CardContent>
			</Card>
		</form>
	);
}

function TunerStatusBadge(props: {
	refreshing: boolean;
	status: StatusState | undefined;
}) {
	const { refreshing, status } = props;
	if (refreshing && !status) {
		return (
			<Badge variant="outline" data-testid="tuner-status-checking">
				Checking…
			</Badge>
		);
	}
	if (!status) {
		return (
			<Badge variant="outline" data-testid="tuner-status-unknown">
				Status unknown
			</Badge>
		);
	}
	if (status.online) {
		return (
			<Badge variant="success" data-testid="tuner-status-online">
				Reachable
			</Badge>
		);
	}
	return (
		<Badge variant="danger" data-testid="tuner-status-offline">
			{status.message ? `Unreachable — ${status.message}` : "Unreachable"}
		</Badge>
	);
}

type ManualTunerFormProps = {
	onCreated: () => Promise<void> | void;
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

			const candidate = buildManualBody(kind, name, field1, field2);
			const parsed = tunerCreateSchema.safeParse(candidate);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				setError(first ? first.message : "Invalid input");
				return;
			}

			setSubmitting(true);
			try {
				await createTuner(parsed.data);
				setName("");
				setField1("");
				setField2("");
				await onCreated();
			} catch (err) {
				setError(formatErrorMessage(err, "Could not save"));
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
			noValidate
			onSubmit={onSubmit}
			aria-label="Add tuner"
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
				<TunerFields
					labels={labels}
					name={name}
					field1={field1}
					field2={field2}
					onNameChange={setName}
					onField1Change={setField1}
					onField2Change={setField2}
				/>
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

type EditTunerFormProps = {
	tuner: Tuner;
	onCancel: () => void;
	onSaved: () => Promise<void> | void;
};

/** Edits every user-configurable value while preserving the tuner kind. */
function EditTunerForm({ tuner, onCancel, onSaved }: EditTunerFormProps) {
	const initialFields = editableFields(tuner);
	const [name, setName] = useState(tuner.name);
	const [field1, setField1] = useState(initialFields.field1);
	const [field2, setField2] = useState(initialFields.field2);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);

			const candidate = buildManualBody(tuner.kind, name, field1, field2);
			const parsed = tunerCreateSchema.safeParse(candidate);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				setError(first ? first.message : "Invalid input");
				return;
			}

			setSubmitting(true);
			try {
				let update = parsed.data;
				const deviceId = tuner.config["deviceId"];
				// Keep discovery metadata that is not directly user-editable.
				if (update.kind === "hdhomerun" && typeof deviceId === "string") {
					update = {
						...update,
						config: { ...update.config, deviceId }
					};
				}
				await updateTuner(tuner.id, update);
				await onSaved();
			} catch (err) {
				setError(formatErrorMessage(err, "Could not update tuner"));
			} finally {
				setSubmitting(false);
			}
		},
		[field1, field2, name, onSaved, tuner.id, tuner.kind]
	);

	return (
		<form
			noValidate
			onSubmit={onSubmit}
			aria-label={`Edit ${tuner.name}`}
			className="basis-full space-y-3 border-t border-border pt-4"
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="space-y-1 text-sm">
					<span className="text-primary">Kind</span>
					<Input value={tuner.kind.toUpperCase()} disabled />
				</label>
				<TunerFields
					labels={MANUAL_FIELD_LABELS[tuner.kind]}
					name={name}
					field1={field1}
					field2={field2}
					onNameChange={setName}
					onField1Change={setField1}
					onField2Change={setField2}
				/>
			</div>

			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}

			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={onCancel}
					disabled={submitting}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={submitting}>
					{submitting ? (
						<Spinner aria-hidden="true" className="h-4 w-4" />
					) : null}
					{submitting ? "Saving…" : "Save changes"}
				</Button>
			</div>
		</form>
	);
}

type TunerFieldsProps = {
	labels: (typeof MANUAL_FIELD_LABELS)[TunerKind];
	name: string;
	field1: string;
	field2: string;
	onNameChange: (value: string) => void;
	onField1Change: (value: string) => void;
	onField2Change: (value: string) => void;
};

/** Shared fields keep add and edit validation inputs consistent. */
function TunerFields(props: TunerFieldsProps) {
	const {
		labels,
		name,
		field1,
		field2,
		onNameChange,
		onField1Change,
		onField2Change
	} = props;

	return (
		<>
			<label className="space-y-1 text-sm">
				<span className="text-primary">Name</span>
				<Input
					value={name}
					onChange={(event) => onNameChange(event.target.value)}
					placeholder="My HDHomeRun"
					required
				/>
			</label>
			<label className="space-y-1 text-sm sm:col-span-2">
				<span className="text-primary">{labels.field1}</span>
				<Input
					value={field1}
					onChange={(event) => onField1Change(event.target.value)}
					placeholder={labels.field1Placeholder}
					required
				/>
			</label>
			{labels.field2 ? (
				<label className="space-y-1 text-sm sm:col-span-2">
					<span className="text-primary">{labels.field2}</span>
					<Input
						value={field2}
						onChange={(event) => onField2Change(event.target.value)}
						placeholder={labels.field2Placeholder}
					/>
				</label>
			) : null}
		</>
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

function buildManualBody(
	kind: TunerKind,
	name: string,
	field1: string,
	field2: string
): unknown {
	const trimmedName = name.trim();
	const trimmed1 = field1.trim();
	const trimmed2 = field2.trim();
	if (kind === "hdhomerun") {
		return {
			kind: "hdhomerun",
			name: trimmedName,
			config: { host: trimmed1 }
		};
	}
	if (kind === "iptv") {
		const config: Record<string, unknown> = { url: trimmed1 };
		if (trimmed2) config.epgUrl = trimmed2;
		return { kind: "iptv", name: trimmedName, config };
	}
	const config: Record<string, unknown> = { url: trimmed1 };
	if (trimmed2) config.channelName = trimmed2;
	return { kind: "hls", name: trimmedName, config };
}

/** Maps persisted per-kind config into the two editable form fields. */
function editableFields(tuner: Tuner): { field1: string; field2: string } {
	if (tuner.kind === "hdhomerun") {
		return { field1: String(tuner.config["host"] ?? ""), field2: "" };
	}
	if (tuner.kind === "iptv") {
		return {
			field1: String(tuner.config["url"] ?? ""),
			field2: String(tuner.config["epgUrl"] ?? "")
		};
	}
	return {
		field1: String(tuner.config["url"] ?? ""),
		field2: String(tuner.config["channelName"] ?? "")
	};
}

function describeConfig(candidate: TunerCreate): string {
	switch (candidate.kind) {
		case "hdhomerun":
			return candidate.config.deviceId
				? `${candidate.config.host} (${candidate.config.deviceId})`
				: candidate.config.host;
		case "iptv":
			return candidate.config.url;
		case "hls":
			return candidate.config.url;
	}
}

function describeStoredConfig(tuner: Tuner): string {
	const c = tuner.config as Record<string, unknown>;
	if (tuner.kind === "hdhomerun") {
		return String(c["deviceId"] ?? c["host"] ?? "");
	}
	return String(c["url"] ?? "");
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

// Re-export ApiError so callers can use this section without re-importing.
export { ApiError };
