"use client";

import type { ChannelListItem } from "@signalhaven/shared";
import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { useEffect, useRef } from "react";

import { IconButton } from "../_ui/IconButton";
import { cn } from "../_ui/cn";

export interface ChannelSwitcherProps {
	/** Channels in the order they should appear (favorites first). */
	channels: ChannelListItem[];
	/** Subset of `channels` that the user has favorited. */
	favorites: ReadonlySet<string>;
	/** Currently watched channel id. */
	currentId: string;
	/** Callback fired when the user picks a channel from the strip. */
	onSelect: (channelId: string) => void;
	/** Channel-up button (PgUp equivalent). */
	onChannelUp: () => void;
	/** Channel-down button (PgDn equivalent). */
	onChannelDown: () => void;
}

/**
 * Horizontal-scroll channel strip rendered below the player. Highlights
 * favorites with a star and auto-scrolls the active channel into view
 * when it changes (PgUp / PgDn or remote-style on-screen buttons).
 */
export function ChannelSwitcher(props: ChannelSwitcherProps) {
	const {
		channels,
		favorites,
		currentId,
		onSelect,
		onChannelUp,
		onChannelDown
	} = props;

	const itemRefs = useRef(new Map<string, HTMLButtonElement>());

	useEffect(() => {
		const node = itemRefs.current.get(currentId);
		if (node && typeof node.scrollIntoView === "function") {
			node.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
				inline: "center"
			});
		}
	}, [currentId]);

	return (
		<section
			data-testid="watch-switcher"
			aria-label="Channel switcher"
			className="rounded-lg border border-border bg-surface p-2"
		>
			<div className="flex items-center gap-2">
				<IconButton
					aria-label="Channel up"
					data-testid="watch-channel-up"
					variant="ghost"
					size="sm"
					onClick={onChannelUp}
				>
					<ChevronUp aria-hidden="true" className="h-4 w-4" />
				</IconButton>
				<div className="flex flex-1 gap-2 overflow-x-auto scroll-smooth py-1">
					{channels.map((c) => {
						const active = c.id === currentId;
						const isFav = favorites.has(c.id);
						return (
							<button
								key={c.id}
								ref={(node) => {
									if (node) itemRefs.current.set(c.id, node);
									else itemRefs.current.delete(c.id);
								}}
								type="button"
								onClick={() => onSelect(c.id)}
								aria-current={active ? "true" : undefined}
								data-testid={`watch-channel-${c.id}`}
								className={cn(
									"flex shrink-0 items-center gap-1 rounded-md border px-3 py-1.5 text-xs",
									"transition-colors motion-reduce:transition-none",
									"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
									active
										? "border-accent bg-accent text-accent-foreground"
										: "border-border bg-surface text-primary hover:bg-surface-muted"
								)}
							>
								{isFav ? (
									<Star
										aria-hidden="true"
										className={cn(
											"h-3 w-3",
											active
												? "fill-current"
												: "fill-yellow-400 text-yellow-400"
										)}
									/>
								) : null}
								<span className="font-medium">{c.number}</span>
								<span className={active ? "" : "text-secondary"}>{c.name}</span>
							</button>
						);
					})}
				</div>
				<IconButton
					aria-label="Channel down"
					data-testid="watch-channel-down"
					variant="ghost"
					size="sm"
					onClick={onChannelDown}
				>
					<ChevronDown aria-hidden="true" className="h-4 w-4" />
				</IconButton>
			</div>
		</section>
	);
}
