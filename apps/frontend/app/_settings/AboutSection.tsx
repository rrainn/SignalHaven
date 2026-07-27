"use client";

import type { SystemInfo } from "@signalhaven/shared";
import { Check, CircleAlert, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getSystemInfo } from "../../lib/api-client";
import { BrandMark } from "../_layout/BrandMark";
import { Button } from "../_ui/Button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from "../_ui/Card";
import { Spinner } from "../_ui/Spinner";

const SYSTEM_INFO_TIMEOUT_MS = 10_000;

export type AboutSectionProps = {
	/** Test seam and optional server-provided snapshot. */
	initialInfo?: SystemInfo;
	/** Test seam for exercising loading and retry behavior. */
	loadInfo?: (signal?: AbortSignal) => Promise<SystemInfo>;
};

type LoadState =
	| { status: "loading" }
	| { status: "ready"; info: SystemInfo; receivedAtMs: number }
	| { status: "error"; message: string };

/** Forward cancellation to the shared API client without recreating the loader. */
function loadSystemInfo(signal?: AbortSignal): Promise<SystemInfo> {
	return getSystemInfo(signal ? { signal } : undefined);
}

/** Show the build identity and runtime age of the connected server. */
export function AboutSection(props: AboutSectionProps) {
	const [state, setState] = useState<LoadState>(() =>
		props.initialInfo
			? { status: "ready", info: props.initialInfo, receivedAtMs: Date.now() }
			: { status: "loading" }
	);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const requestVersion = useRef(0);
	const activeController = useRef<AbortController | null>(null);
	const loadInfo = props.loadInfo ?? loadSystemInfo;

	const load = useCallback(async () => {
		activeController.current?.abort();
		const controller = new AbortController();
		activeController.current = controller;
		const version = ++requestVersion.current;
		let timedOut = false;
		const timeout = window.setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, SYSTEM_INFO_TIMEOUT_MS);
		setState({ status: "loading" });
		try {
			const info = await loadInfo(controller.signal);
			if (requestVersion.current === version) {
				const receivedAtMs = Date.now();
				setNowMs(receivedAtMs);
				setState({ status: "ready", info, receivedAtMs });
			}
		} catch (error) {
			if (requestVersion.current === version) {
				if (controller.signal.aborted && !timedOut) return;
				setState({
					status: "error",
					message: timedOut
						? "Server information took too long to respond. Try again."
						: error instanceof Error
							? error.message
							: "Could not load server information"
				});
			}
		} finally {
			window.clearTimeout(timeout);
			if (activeController.current === controller) {
				activeController.current = null;
			}
		}
	}, [loadInfo]);

	useEffect(() => {
		if (!props.initialInfo) {
			void load();
		}
		return () => {
			// Stop network work and ignore a response after this tab unmounts.
			activeController.current?.abort();
			requestVersion.current += 1;
		};
	}, [load, props.initialInfo]);

	useEffect(() => {
		if (state.status !== "ready") return;

		// Keep the snapshot useful without repeatedly polling the server.
		const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(interval);
	}, [state.status]);

	const displayedUptime =
		state.status === "ready"
			? state.info.uptime + (nowMs - state.receivedAtMs) / 1_000
			: 0;

	return (
		<Card data-testid="about-section">
			<CardHeader>
				<div className="flex items-start gap-3">
					<BrandMark className="h-10 w-10 shrink-0 text-primary" />
					<div className="min-w-0 space-y-1.5 pt-0.5">
						<CardTitle>About SignalHaven</CardTitle>
						<CardDescription className="max-w-xl leading-5">
							Build details for the server this browser is connected to.
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="min-h-44">
				{state.status === "loading" ? (
					<div
						role="status"
						className="flex min-h-32 items-center gap-3 text-sm text-secondary"
					>
						<Spinner aria-hidden="true" className="h-5 w-5" />
						<div className="space-y-0.5">
							<p className="font-medium text-primary">Connecting to server</p>
							<p>Loading build information…</p>
						</div>
					</div>
				) : state.status === "error" ? (
					<div className="flex min-h-32 items-center">
						<div className="w-full rounded-md border border-danger/30 bg-danger/10 p-4">
							<div className="flex items-start gap-3">
								<CircleAlert
									aria-hidden="true"
									className="mt-0.5 h-5 w-5 shrink-0 text-danger"
								/>
								<div className="min-w-0 space-y-1">
									<p className="text-sm font-medium text-primary">
										Server details unavailable
									</p>
									<p role="alert" className="break-words text-sm text-danger">
										{state.message}
									</p>
								</div>
							</div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="mt-4"
								onClick={() => void load()}
							>
								Try again
							</Button>
						</div>
					</div>
				) : (
					<dl className="divide-y divide-border text-sm">
						<InfoRow
							label="Version"
							value={
								<span className="font-medium tabular-nums">
									{state.info.version}
								</span>
							}
						/>
						{isEmbeddedCommit(state.info.gitCommit) ? (
							<InfoRow
								label="Git commit"
								value={
									<div className="flex min-w-0 items-center justify-between gap-3">
										<code className="min-w-0 break-all font-mono text-xs text-primary">
											{state.info.gitCommit}
										</code>
										<CopyCommitButton commit={state.info.gitCommit} />
									</div>
								}
							/>
						) : (
							<InfoRow
								label="Git commit"
								value={
									<div className="space-y-1">
										<p>Not embedded</p>
										<p className="text-xs text-secondary">
											Development builds may omit source revision metadata.
										</p>
									</div>
								}
							/>
						)}
						<InfoRow
							label="Server uptime"
							value={
								<time
									className="font-medium tabular-nums"
									dateTime={formatUptimeDuration(displayedUptime)}
								>
									{formatServerUptime(displayedUptime)}
								</time>
							}
						/>
					</dl>
				)}
			</CardContent>
		</Card>
	);
}

type InfoRowProps = {
	label: string;
	value: ReactNode;
};

/** Keep metadata rows aligned while allowing long hashes to wrap on mobile. */
function InfoRow({ label, value }: InfoRowProps) {
	return (
		<div className="grid min-w-0 gap-1.5 py-4 first:pt-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center sm:gap-4">
			<dt className="font-medium text-secondary">{label}</dt>
			<dd className="min-w-0 break-words text-primary">{value}</dd>
		</div>
	);
}

type CopyState = "idle" | "copied" | "error";

/** Copy the revision used for diagnostics and acknowledge the outcome in-place. */
function CopyCommitButton({ commit }: { commit: string }) {
	const [copyState, setCopyState] = useState<CopyState>("idle");
	const resetTimer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (resetTimer.current !== null) {
				window.clearTimeout(resetTimer.current);
			}
		},
		[]
	);

	const copyCommit = useCallback(async () => {
		if (resetTimer.current !== null) {
			window.clearTimeout(resetTimer.current);
		}

		try {
			await navigator.clipboard.writeText(commit);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}

		// Keep feedback long enough to notice without making it persistent state.
		resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2_000);
	}, [commit]);

	const accessibleLabel =
		copyState === "copied"
			? "Git commit copied"
			: copyState === "error"
				? "Could not copy Git commit"
				: "Copy Git commit";

	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			aria-label={accessibleLabel}
			className="h-11 w-11 shrink-0 px-0 text-secondary sm:h-8 sm:w-auto sm:px-3"
			onClick={() => void copyCommit()}
		>
			{copyState === "copied" ? (
				<Check aria-hidden="true" className="h-4 w-4 text-success" />
			) : (
				<Copy aria-hidden="true" className="h-4 w-4" />
			)}
			<span className="hidden sm:inline" aria-hidden="true">
				{copyState === "copied"
					? "Copied"
					: copyState === "error"
						? "Copy failed"
						: "Copy"}
			</span>
		</Button>
	);
}

/** Treat the backend fallback as an explicit development-build state. */
function isEmbeddedCommit(commit: string): boolean {
	return commit.trim().toLowerCase() !== "unknown";
}

/** Supply machine-readable uptime to assistive tools and integrations. */
function formatUptimeDuration(totalSeconds: number): string {
	return `PT${Math.max(0, Math.floor(totalSeconds))}S`;
}

/** Format uptime at minute precision once the server has been up for a minute. */
export function formatServerUptime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds < 60) return `${seconds}s`;

	const totalMinutes = Math.floor(seconds / 60);
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	const parts = [
		days > 0 ? `${days}d` : null,
		hours > 0 ? `${hours}h` : null,
		minutes > 0 || (days === 0 && hours === 0) ? `${minutes}m` : null
	].filter((part): part is string => part !== null);
	return parts.join(" ");
}
