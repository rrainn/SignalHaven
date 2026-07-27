"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn";

/**
 * IconButton — a square button that wraps a single icon.
 *
 * An accessible name is **required** via `aria-label` (or `aria-labelledby`)
 * since there is no visible text. The component does not enforce this in
 * types because consumers may use `aria-labelledby`, but stories / tests
 * demonstrate the pattern.
 */
const iconButtonStyles = cva(
	[
		"inline-flex items-center justify-center rounded-md",
		"transition-colors motion-reduce:transition-none",
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
		"disabled:pointer-events-none disabled:opacity-50"
	],
	{
		variants: {
			variant: {
				primary: "bg-accent text-accent-foreground hover:bg-accent/90",
				secondary:
					"bg-surface-muted text-primary hover:bg-surface-muted/70 border border-border",
				ghost: "bg-transparent text-primary hover:bg-surface-muted",
				outline:
					"bg-transparent text-primary border border-border hover:bg-surface-muted",
				danger: "bg-danger text-white hover:bg-danger/90"
			},
			size: {
				sm: "h-8 w-8 [&_svg]:h-4 [&_svg]:w-4",
				md: "h-10 w-10 [&_svg]:h-5 [&_svg]:w-5",
				lg: "h-12 w-12 [&_svg]:h-6 [&_svg]:w-6"
			}
		},
		defaultVariants: {
			variant: "ghost",
			size: "md"
		}
	}
);

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof iconButtonStyles> & {
		/** Visible icon node (lucide-react icon, etc). */
		children: ReactNode;
	};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
	function IconButton(
		{ className, variant, size, type = "button", children, ...rest },
		ref
	) {
		return (
			<button
				ref={ref}
				type={type}
				data-density-control="icon-button"
				data-density-size={size ?? "md"}
				className={cn(iconButtonStyles({ variant, size }), className)}
				{...rest}
			>
				{children}
			</button>
		);
	}
);

export { iconButtonStyles };
