import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "./cn";

const spinnerStyles = cva("motion-safe:animate-spin text-muted", {
	variants: {
		size: {
			sm: "h-4 w-4",
			md: "h-6 w-6",
			lg: "h-10 w-10"
		}
	},
	defaultVariants: { size: "md" }
});

export type SpinnerProps = HTMLAttributes<HTMLSpanElement> &
	VariantProps<typeof spinnerStyles> & {
		/** Visually hidden label announced to assistive tech. */
		label?: string;
	};

/**
 * Spinner — busy indicator.
 *
 * The icon is `aria-hidden`; an SR-only label communicates the loading state
 * to screen readers. The wrapper uses `role="status"` with `aria-live="polite"`
 * so updates are announced unobtrusively.
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(
	function Spinner({ className, size, label = "Loading", ...rest }, ref) {
		return (
			<span
				ref={ref}
				role="status"
				aria-live="polite"
				className={cn("inline-flex items-center", className)}
				{...rest}
			>
				<Loader2 className={spinnerStyles({ size })} aria-hidden="true" />
				<span className="sr-only">{label}</span>
			</span>
		);
	}
);
