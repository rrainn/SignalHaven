"use client";

import type { ComskipWorkItem, FfmpegWorkItem } from "@signalhaven/shared";
import { CircleStop, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
	formatClientError,
	getExternalIp,
	listComskipWork,
	listFfmpegWork,
	stopFfmpegWork
} from "../../lib/api-client";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { EmptyState } from "../_ui/EmptyState";
import { PageHeader } from "../_ui/PageHeader";
import { Spinner } from "../_ui/Spinner";
import { useAdvancedMode } from "./AdvancedModeProvider";

/** Operator-only view of active media-processing work on this server. */
export function AdvancedPage() {
	const advanced = useAdvancedMode();
	const [ffmpegItems, setFfmpegItems] = useState<FfmpegWorkItem[]>([]);
	const [comskipItems, setComskipItems] = useState<ComskipWorkItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [ffmpegError, setFfmpegError] = useState<string | null>(null);
	const [comskipError, setComskipError] = useState<string | null>(null);
	const [stopping, setStopping] = useState<string | null>(null);
	const [externalIp, setExternalIp] = useState<string | null>(null);
	const [externalIpLoading, setExternalIpLoading] = useState(true);
	const [externalIpError, setExternalIpError] = useState<string | null>(null);

	const refreshWork = useCallback(async () => {
		if (!advanced.enabled) return;
		setFfmpegError(null);
		setComskipError(null);
		const [ffmpegResult, comskipResult] = await Promise.allSettled([
			listFfmpegWork(),
			listComskipWork()
		]);
		if (ffmpegResult.status === "fulfilled") {
			setFfmpegItems(ffmpegResult.value.items);
		} else {
			setFfmpegError(
				formatClientError(
					ffmpegResult.reason,
					"Could not load FFmpeg jobs.",
					true
				)
			);
		}
		if (comskipResult.status === "fulfilled") {
			setComskipItems(comskipResult.value.items);
		} else {
			setComskipError(
				formatClientError(
					comskipResult.reason,
					"Could not load Comskip jobs.",
					true
				)
			);
		}
		setLoading(false);
	}, [advanced.enabled]);

	const refreshExternalIp = useCallback(async () => {
		if (!advanced.enabled) return;
		try {
			const result = await getExternalIp();
			setExternalIp(result.ip);
			setExternalIpError(null);
		} catch (failure) {
			setExternalIpError(
				formatClientError(
					failure,
					"Could not determine the server external IP.",
					true
				)
			);
		}
		setExternalIpLoading(false);
	}, [advanced.enabled]);

	const refreshAll = useCallback(async () => {
		// Keep the independent status cards useful if either request fails.
		await Promise.allSettled([refreshWork(), refreshExternalIp()]);
	}, [refreshExternalIp, refreshWork]);

	useEffect(() => {
		void refreshAll();
		// Active work is volatile, while the privacy-sensitive IP lookup is one-shot.
		const timer = window.setInterval(() => void refreshWork(), 3_000);
		return () => window.clearInterval(timer);
	}, [refreshAll, refreshWork]);

	if (!advanced.enabled) {
		return (
			<section className="space-y-4" aria-labelledby="advanced-heading">
				<PageHeader
					headingId="advanced-heading"
					title="Advanced"
					description="Inspect and manage operator-level media processing work."
				/>
				<EmptyState
					icon={<Wrench aria-hidden="true" />}
					title="Advanced mode is off"
					description="Enable Advanced mode in Settings → Appearance to inspect server tasks."
				/>
			</section>
		);
	}

	return (
		<section className="space-y-6" aria-labelledby="advanced-heading">
			<PageHeader
				headingId="advanced-heading"
				title="Active tasks"
				description="FFmpeg and Comskip jobs currently running in this server process."
				actions={
					<Button
						variant="secondary"
						onClick={() => void refreshAll()}
						disabled={loading}
					>
						<RefreshCw aria-hidden="true" className="h-4 w-4" /> Refresh
					</Button>
				}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Server external IP</CardTitle>
				</CardHeader>
				<CardContent>
					{externalIpLoading ? (
						<Spinner label="Loading server external IP…" />
					) : externalIpError ? (
						<p role="alert" className="text-sm text-danger">
							{externalIpError}
						</p>
					) : (
						<code className="text-lg">{externalIp ?? "Unavailable"}</code>
					)}
				</CardContent>
			</Card>

			{loading ? (
				<Spinner label="Loading active tasks…" />
			) : (
				<>
					<FfmpegJobsSection
						items={ffmpegItems}
						error={ffmpegError}
						stopping={stopping}
						onStop={async (item) => {
							setStopping(item.id);
							try {
								await stopFfmpegWork(item.id);
								await refreshWork();
							} catch (failure) {
								setFfmpegError(
									formatClientError(
										failure,
										"Could not stop FFmpeg work.",
										true
									)
								);
							} finally {
								setStopping(null);
							}
						}}
					/>
					<ComskipJobsSection items={comskipItems} error={comskipError} />
				</>
			)}
		</section>
	);
}

/** Render active FFmpeg jobs with the existing graceful-stop control. */
function FfmpegJobsSection({
	items,
	error,
	stopping,
	onStop
}: {
	items: FfmpegWorkItem[];
	error: string | null;
	stopping: string | null;
	onStop: (item: FfmpegWorkItem) => Promise<void>;
}) {
	return (
		<section className="space-y-3" aria-labelledby="ffmpeg-jobs-heading">
			<div>
				<h2 id="ffmpeg-jobs-heading" className="text-lg font-semibold">
					FFmpeg jobs
				</h2>
				<p className="text-sm text-secondary">
					Live streams, recordings, and recording playback.
				</p>
			</div>
			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}
			{items.length === 0 ? (
				<EmptyState
					icon={<Wrench aria-hidden="true" />}
					title="No active FFmpeg jobs"
					description="Live streams and in-progress recordings will appear here."
				/>
			) : (
				<ul className="grid gap-3">
					{items.map((item) => (
						<li key={item.id}>
							<Card>
								<CardHeader>
									<CardTitle>{item.label}</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-wrap items-end justify-between gap-4">
									<dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-sm">
										<dt className="text-secondary">Type</dt>
										<dd>{formatFfmpegKind(item.kind)}</dd>
										<dt className="text-secondary">State</dt>
										<dd>{item.state}</dd>
										<dt className="text-secondary">Started</dt>
										<dd>{new Date(item.startedAt).toLocaleString()}</dd>
										{item.profile ? (
											<>
												<dt className="text-secondary">Profile</dt>
												<dd>{item.profile}</dd>
											</>
										) : null}
										{item.hwaccel !== undefined ? (
											<>
												<dt className="text-secondary">Acceleration</dt>
												<dd>{item.hwaccel ?? "Software"}</dd>
											</>
										) : null}
										{item.clientCount !== undefined ? (
											<>
												<dt className="text-secondary">In-flight requests</dt>
												<dd>{item.clientCount}</dd>
											</>
										) : null}
									</dl>
									<Button
										variant="danger"
										disabled={stopping === item.id}
										onClick={() => void onStop(item)}
									>
										<CircleStop aria-hidden="true" className="h-4 w-4" />
										{stopping === item.id ? "Stopping…" : "Stop"}
									</Button>
								</CardContent>
							</Card>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** Render Comskip work as read-only because cancellation belongs to recordings. */
function ComskipJobsSection({
	items,
	error
}: {
	items: ComskipWorkItem[];
	error: string | null;
}) {
	return (
		<section className="space-y-3" aria-labelledby="comskip-jobs-heading">
			<div>
				<h2 id="comskip-jobs-heading" className="text-lg font-semibold">
					Comskip jobs
				</h2>
				<p className="text-sm text-secondary">
					Commercial detection running against completed recordings.
				</p>
			</div>
			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}
			{items.length === 0 ? (
				<EmptyState
					icon={<Wrench aria-hidden="true" />}
					title="No active Comskip jobs"
					description="Commercial detection tasks will appear here while they run."
				/>
			) : (
				<ul className="grid gap-3">
					{items.map((item) => (
						<li key={item.id}>
							<Card>
								<CardHeader>
									<CardTitle>{item.label}</CardTitle>
								</CardHeader>
								<CardContent>
									<dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-sm sm:max-w-md">
										<dt className="text-secondary">Type</dt>
										<dd>Commercial detection</dd>
										<dt className="text-secondary">State</dt>
										<dd>{item.state}</dd>
										<dt className="text-secondary">Started</dt>
										<dd>{new Date(item.startedAt).toLocaleString()}</dd>
									</dl>
								</CardContent>
							</Card>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** Convert stable API job kinds into operator-friendly labels. */
function formatFfmpegKind(kind: FfmpegWorkItem["kind"]): string {
	if (kind === "live-stream") return "Live stream";
	if (kind === "recording") return "Recording";
	return "Recording playback";
}
