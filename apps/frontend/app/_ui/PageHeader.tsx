import type { ReactNode } from "react";

import { cn } from "./cn";

export interface PageHeaderProps {
	/** Optional controls that belong to the page as a whole. */
	actions?: ReactNode;
	className?: string;
	description?: ReactNode;
	/** Stable heading id used by the containing page landmark. */
	headingId?: string;
	title: ReactNode;
}

/**
 * Establishes one title rhythm across top-level application views.
 * Actions wrap below the title on narrow screens so neither text nor controls
 * are compressed into an unreadable row.
 */
export function PageHeader({
	actions,
	className,
	description,
	headingId,
	title
}: PageHeaderProps) {
	return (
		<header
			className={cn(
				"flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
				className
			)}
		>
			<div className="min-w-0 space-y-1">
				<h1
					id={headingId}
					className="text-2xl font-semibold tracking-tight text-primary"
				>
					{title}
				</h1>
				{description ? (
					<div className="max-w-3xl text-sm leading-6 text-secondary">
						{description}
					</div>
				) : null}
			</div>
			{actions ? <div className="shrink-0">{actions}</div> : null}
		</header>
	);
}
