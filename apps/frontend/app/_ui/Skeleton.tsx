import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "./cn";

/**
 * Skeleton — a loading placeholder.
 *
 * Uses Tailwind's `animate-pulse` which is automatically disabled by the
 * browser when the user has `prefers-reduced-motion: reduce` set
 * (Tailwind ships the `motion-safe:` qualifier we apply here).
 */
export const Skeleton = forwardRef<
	HTMLDivElement,
	HTMLAttributes<HTMLDivElement>
>(function Skeleton({ className, ...rest }, ref) {
	return (
		<div
			ref={ref}
			aria-hidden="true"
			className={cn(
				"rounded-md bg-surface-muted motion-safe:animate-pulse",
				className
			)}
			{...rest}
		/>
	);
});
