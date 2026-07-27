"use client";

import type { FfmpegWorkItem } from "@signalhaven/shared";
import { CircleStop, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
	formatClientError,
	getExternalIp,
	listFfmpegWork,
	stopFfmpegWork
} from "../../lib/api-client";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { EmptyState } from "../_ui/EmptyState";
import { PageHeader } from "../_ui/PageHeader";
import { Spinner } from "../_ui/Spinner";
import { useAdvancedMode } from "./AdvancedModeProvider";

/** Operator-only view of FFmpeg work owned by this SignalHaven process. */
export function AdvancedPage() {
	const advanced = useAdvancedMode();
	const [items, setItems] = useState<FfmpegWorkItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [stopping, setStopping] = useState<string | null>(null);
	const [externalIp, setExternalIp] = useState<string | null>(null);
	const [externalIpLoading, setExternalIpLoading] = useState(true);
	const [externalIpError, setExternalIpError] = useState<string | null>(null);

	const refreshWork = useCallback(async () => {
		if (!advanced.enabled) return;
		setError(null);
		try {
			const result = await listFfmpegWork();
			setItems(result.items);
		} catch (failure) {
			setError(formatClientError(failure, "Could not load FFmpeg work.", true));
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
		// FFmpeg work is volatile, while the privacy-sensitive IP lookup is one-shot.
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
					description="Enable Advanced mode in Settings → Appearance to inspect FFmpeg work."
				/>
			</section>
		);
	}

	return (
		<section className="space-y-4" aria-labelledby="advanced-heading">
			<PageHeader
				headingId="advanced-heading"
				title="FFmpeg work"
				description="Active live streams and recordings in this server process."
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

			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}
			{loading ? (
				<Spinner label="Loading FFmpeg work…" />
			) : items.length === 0 ? (
				<EmptyState
					icon={<Wrench aria-hidden="true" />}
					title="No active FFmpeg work"
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
										<dd>
											{item.kind === "live-stream"
												? "Live stream"
												: item.kind === "recording"
													? "Recording"
													: "Recording playback"}
										</dd>
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
										onClick={async () => {
											setStopping(item.id);
											try {
												await stopFfmpegWork(item.id);
												await refreshWork();
											} catch (failure) {
												setError(
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
