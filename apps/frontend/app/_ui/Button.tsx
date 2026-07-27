"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn";

/**
 * Button variants and sizes.
 *
 * All transitions are wrapped in `motion-safe:` so they are dropped under
 * `prefers-reduced-motion: reduce` (Tailwind's `motion-reduce` strategy).
 */
const buttonStyles = cva(
	[
		"inline-flex items-center justify-center gap-2",
		"select-none whitespace-nowrap rounded-md font-medium",
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
				danger: "bg-danger text-white hover:bg-danger/90",
				link: "bg-transparent text-accent underline-offset-4 hover:underline px-0 h-auto"
			},
			size: {
				sm: "h-8 px-3 text-xs",
				md: "h-10 px-4 text-sm",
				lg: "h-12 px-6 text-base"
			},
			block: {
				true: "w-full",
				false: ""
			}
		},
		defaultVariants: {
			variant: "primary",
			size: "md",
			block: false
		}
	}
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonStyles>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	function Button(
		{ className, variant, size, block, type = "button", ...rest },
		ref
	) {
		return (
			<button
				ref={ref}
				type={type}
				data-density-control="button"
				data-density-size={size ?? "md"}
				className={cn(buttonStyles({ variant, size, block }), className)}
				{...rest}
			/>
		);
	}
);

export { buttonStyles };
