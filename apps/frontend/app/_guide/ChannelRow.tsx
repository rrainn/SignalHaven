"use client";

import { memo } from "react";
import type { EpgGridChannel } from "@signalhaven/shared";
import { Play, Tv } from "lucide-react";
import Link from "next/link";

import { ChannelLogo } from "../_ui/ChannelLogo";

export interface ChannelRowProps {
	channel: EpgGridChannel;
	height: number;
	width: number;
}

/**
 * Sticky channel column cell and live-playback link. The image is rendered
 * with `loading="lazy"` so off-screen rows never download it; we always
 * include a textual fallback for accessibility.
 */
function ChannelRowInner(props: ChannelRowProps) {
	const { channel, height, width } = props;
	// Virtualized rows mount frequently, so player routes opt out of speculative
	// prefetching and per-link network-condition subscriptions.
	return (
		<Link
			href={`/watch/${encodeURIComponent(channel.id)}`}
			prefetch={false}
			aria-label={`Watch ${channel.number} ${channel.name}`}
			title={`Watch ${channel.number} ${channel.name} live`}
			data-testid="channel-row"
			data-channel-id={channel.id}
			style={{ position: "sticky", left: 0, width, height }}
			className="pointer-events-auto group flex items-center gap-2 border-b border-r border-border bg-surface px-2 py-1 shadow-[2px_0_0_rgb(var(--color-border))] hover:bg-surface-muted focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
		>
			<div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-muted text-secondary max-[420px]:h-8 max-[420px]:w-8">
				<ChannelLogo
					src={channel.logoUrl}
					size={30}
					className="h-[1.875rem] w-[1.875rem] object-contain max-[420px]:h-6 max-[420px]:w-6"
					fallback={<Tv aria-hidden="true" className="h-4 w-4" />}
				/>
				<span
					aria-hidden="true"
					data-testid="channel-watch-affordance"
					className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-[0_1px_3px_rgb(var(--color-background)/0.5)] ring-2 ring-surface"
				>
					<Play className="h-2.5 w-2.5 fill-current" />
				</span>
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-1.5 max-[420px]:block">
					<span className="text-[11px] font-mono text-muted">
						{channel.number}
					</span>
					<span className="block truncate text-sm font-semibold text-primary group-hover:underline max-[420px]:text-xs">
						{channel.name}
					</span>
				</div>
				{!channel.hasMapping ? (
					<span className="text-[10px] uppercase tracking-wide text-secondary">
						No guide
					</span>
				) : null}
			</div>
		</Link>
	);
}

export const ChannelRow = memo(ChannelRowInner);
