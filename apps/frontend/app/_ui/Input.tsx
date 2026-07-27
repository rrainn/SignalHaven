"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn";

const inputStyles = cva(
	[
		"block w-full rounded-md border border-border bg-surface px-3",
		"text-primary placeholder:text-muted",
		"transition-colors motion-reduce:transition-none",
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
		"disabled:cursor-not-allowed disabled:opacity-60",
		"aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger"
	],
	{
		variants: {
			size: {
				sm: "h-8 text-xs",
				md: "h-10 text-sm",
				lg: "h-12 text-base"
			}
		},
		defaultVariants: {
			size: "md"
		}
	}
);

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> &
	VariantProps<typeof inputStyles>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{ className, size, type = "text", ...rest },
	ref
) {
	return (
		<input
			ref={ref}
			type={type}
			data-density-control="input"
			data-density-size={size ?? "md"}
			className={cn(inputStyles({ size }), className)}
			{...rest}
		/>
	);
});

export { inputStyles };
