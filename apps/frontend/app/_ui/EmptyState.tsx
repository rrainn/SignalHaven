import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "./cn";

export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
	/** Optional decorative icon (or any node) shown above the title. */
	icon?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	/** Primary action(s) — typically a `<Button>`. */
	action?: ReactNode;
};

/**
 * EmptyState — a friendly placeholder for no-data screens.
 *
 * Pure presentational; semantics are minimal so consumers can wrap it in
 * whatever landmark they need (`<section>`, `<main>`, etc.).
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
	function EmptyState(
		{ className, icon, title, description, action, ...rest },
		ref
	) {
		return (
			<div
				ref={ref}
				className={cn(
					"flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface/50 p-8 text-center",
					className
				)}
				{...rest}
			>
				{icon ? (
					<div
						className="text-muted [&_svg]:h-10 [&_svg]:w-10"
						aria-hidden="true"
					>
						{icon}
					</div>
				) : null}
				<h3 className="text-base font-semibold text-primary">{title}</h3>
				{description ? (
					<p className="max-w-sm text-sm text-secondary">{description}</p>
				) : null}
				{action ? <div className="mt-2">{action}</div> : null}
			</div>
		);
	}
);
