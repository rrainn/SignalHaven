"use client";

import type {
	ChannelDiagnostics,
	ChannelDiagnosticsSource,
	ChannelListItem
} from "@signalhaven/shared";
import { AlertTriangle, Ellipsis, Info, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getChannelDiagnostics } from "../../lib/api-client";
import { useAdvancedModeOptional } from "../_advanced/AdvancedModeProvider";
import { Button } from "../_ui/Button";
import { IconButton } from "../_ui/IconButton";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalHeader,
	ModalTitle
} from "../_ui/Modal";
import { Spinner } from "../_ui/Spinner";

export interface ChannelInfoMenuProps {
	channel: ChannelListItem;
	/** Test and preview seam; production resolves diagnostics from the API. */
	loadDiagnostics?: (channelId: string) => Promise<ChannelDiagnostics>;
}

/** Advanced-only channel actions and the detailed source diagnostics dialog. */
export function ChannelInfoMenu({
	channel,
	loadDiagnostics = getChannelDiagnostics
}: ChannelInfoMenuProps) {
	const advancedMode = useAdvancedModeOptional();
	const advancedEnabled = advancedMode?.enabled ?? false;
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const requestGenerationRef = useRef(0);
	const [menuOpen, setMenuOpen] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [diagnostics, setDiagnostics] = useState<ChannelDiagnostics | null>(
		null
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// A channel change invalidates data resolved for the previous stream.
		requestGenerationRef.current += 1;
		setMenuOpen(false);
		setDialogOpen(false);
		setDiagnostics(null);
		setError(null);
		setLoading(false);
	}, [channel.id]);

	useEffect(() => {
		if (!menuOpen) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () =>
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
	}, [menuOpen]);

	if (!advancedEnabled) return null;

	const load = () => {
		const generation = requestGenerationRef.current + 1;
		requestGenerationRef.current = generation;
		setLoading(true);
		setError(null);
		void loadDiagnostics(channel.id)
			.then((result) => {
				if (requestGenerationRef.current !== generation) return;
				setDiagnostics(result);
			})
			.catch((failure: unknown) => {
				if (requestGenerationRef.current !== generation) return;
				setError(
					failure instanceof Error
						? failure.message
						: "Could not load channel information."
				);
			})
			.finally(() => {
				if (requestGenerationRef.current === generation) setLoading(false);
			});
	};

	const openDialog = () => {
		setMenuOpen(false);
		setDialogOpen(true);
		load();
	};

	return (
		<>
			<div ref={menuRef} className="relative shrink-0">
				<IconButton
					ref={triggerRef}
					aria-label="More channel actions"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					variant="ghost"
					size="sm"
					onClick={() => setMenuOpen((current) => !current)}
				>
					<Ellipsis aria-hidden="true" />
				</IconButton>
				{menuOpen ? (
					<div
						role="menu"
						aria-label="Channel actions"
						className="absolute left-0 top-full z-30 mt-1 min-w-36 rounded-md border border-border bg-surface p-1 text-sm shadow-xl"
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								setMenuOpen(false);
								triggerRef.current?.focus();
							}
						}}
					>
						<button
							autoFocus
							type="button"
							role="menuitem"
							className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-primary hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
							onClick={openDialog}
						>
							<Info aria-hidden="true" className="h-4 w-4" />
							More Info
						</button>
					</div>
				) : null}
			</div>

			<Modal open={dialogOpen} onOpenChange={setDialogOpen}>
				<ModalContent
					className="max-h-[min(48rem,calc(100vh-2rem))] max-w-3xl overflow-y-auto p-4 sm:p-6"
					onCloseAutoFocus={(event) => {
						// The menu item is removed before Radix can restore focus itself.
						event.preventDefault();
						triggerRef.current?.focus();
					}}
				>
					<ModalHeader>
						<ModalTitle>Channel information</ModalTitle>
						<ModalDescription>
							Detailed playback coordinates for {channel.number} {channel.name}.
							Stream URLs and request headers may contain credentials; share
							them carefully.
						</ModalDescription>
					</ModalHeader>

					{loading && diagnostics === null ? (
						<div className="flex min-h-40 items-center justify-center">
							<Spinner label="Resolving channel sources…" />
						</div>
					) : null}

					{error ? (
						<div
							role="alert"
							className="rounded-lg border border-danger bg-surface-muted p-4"
						>
							<div className="flex items-start gap-3">
								<AlertTriangle
									aria-hidden="true"
									className="mt-0.5 h-4 w-4 shrink-0 text-danger"
								/>
								<div className="min-w-0">
									<p className="text-sm font-medium text-primary">
										Could not load channel information
									</p>
									<p className="mt-1 break-words text-sm text-secondary">
										{error}
									</p>
									<Button
										variant="outline"
										size="sm"
										className="mt-3"
										onClick={load}
									>
										<RotateCw aria-hidden="true" className="h-4 w-4" />
										Retry
									</Button>
								</div>
							</div>
						</div>
					) : null}

					{diagnostics ? (
						<ChannelDiagnosticsDetails value={diagnostics} />
					) : null}
				</ModalContent>
			</Modal>
		</>
	);
}

/** Readable definition-list layout keeps long identifiers and URLs selectable. */
function ChannelDiagnosticsDetails({ value }: { value: ChannelDiagnostics }) {
	return (
		<div className="space-y-5" data-testid="channel-diagnostics">
			<section aria-labelledby="logical-channel-heading">
				<h3
					id="logical-channel-heading"
					className="text-sm font-semibold text-primary"
				>
					Logical channel
				</h3>
				<dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
					<DiagnosticRow label="Name" value={value.channel.name} />
					<DiagnosticRow label="Number" value={value.channel.number} />
					<DiagnosticRow label="Channel ID" value={value.channel.id} code />
					<DiagnosticRow label="TVG ID" value={value.channel.tvgId} code />
					<DiagnosticRow
						label="EPG mapping ID"
						value={value.channel.mappedEpgChannelId}
						code
					/>
					<DiagnosticRow
						label="Enabled"
						value={value.channel.enabled ? "Yes" : "No"}
					/>
					<DiagnosticRow
						label="Sort order"
						value={String(value.channel.sortOrder)}
					/>
					<DiagnosticRow
						label="Original logo URL"
						value={value.channel.logoUrl}
						code
					/>
				</dl>
			</section>

			<section aria-labelledby="channel-sources-heading">
				<h3
					id="channel-sources-heading"
					className="text-sm font-semibold text-primary"
				>
					Physical sources ({value.sources.length})
				</h3>
				<div className="mt-2 space-y-3">
					{value.sources.map((source) => (
						<SourceDetails key={source.id} source={source} />
					))}
					{value.sources.length === 0 ? (
						<p className="rounded-lg border border-dashed border-border p-4 text-sm text-secondary">
							No physical sources are attached to this channel.
						</p>
					) : null}
				</div>
			</section>

			<p className="text-xs text-muted">
				Resolved {new Date(value.checkedAt).toLocaleString()}
			</p>
		</div>
	);
}

function SourceDetails({ source }: { source: ChannelDiagnosticsSource }) {
	return (
		<article className="rounded-lg border border-border p-3 sm:p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h4 className="text-sm font-semibold text-primary">
					{source.tunerName}
				</h4>
				<span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-secondary">
					{source.preferred ? "Preferred · " : ""}
					{source.status}
				</span>
			</div>
			<dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
				<DiagnosticRow label="Source name" value={source.name} />
				<DiagnosticRow label="Source number" value={source.number} />
				<DiagnosticRow label="Source ID" value={source.id} code />
				<DiagnosticRow label="Tuner type" value={source.tunerKind} />
				<DiagnosticRow label="Tuner ID" value={source.tunerId} code />
				<DiagnosticRow label="TVG ID" value={source.tvgId} code />
				<DiagnosticRow
					label="Stored provider ID"
					value={source.storedProviderChannelId}
					code
				/>
				<DiagnosticRow
					label="Resolved provider ID"
					value={source.resolvedProviderChannelId}
					code
				/>
				<DiagnosticRow
					label="Original stream URL"
					value={source.streamUrl}
					code
				/>
				<DiagnosticRow label="Original logo URL" value={source.logoUrl} code />
				<DiagnosticRow label="Enabled" value={source.enabled ? "Yes" : "No"} />
				<DiagnosticRow label="Priority" value={String(source.priority)} />
				{source.httpHeaders
					? Object.entries(source.httpHeaders).map(([name, headerValue]) => (
							<DiagnosticRow
								key={name}
								label={`HTTP header · ${name}`}
								value={headerValue}
								code
							/>
						))
					: null}
				{source.error ? (
					<DiagnosticRow label="Resolution error" value={source.error} />
				) : null}
			</dl>
		</article>
	);
}

function DiagnosticRow({
	label,
	value,
	code = false
}: {
	label: string;
	value: string | null | undefined;
	code?: boolean;
}) {
	return (
		<>
			<dt className="font-medium text-secondary">{label}</dt>
			<dd
				className={
					code
						? "select-text break-all font-mono text-xs leading-5 text-primary"
						: "break-words text-primary"
				}
			>
				{value?.trim() ? value : "Not set"}
			</dd>
		</>
	);
}
