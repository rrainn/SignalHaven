import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn";

const badgeStyles = cva(
	"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
	{
		variants: {
			variant: {
				default: "border-border bg-surface-muted text-primary",
				accent: "border-transparent bg-accent text-accent-foreground",
				success: "border-transparent bg-success text-white",
				danger: "border-transparent bg-danger text-white",
				outline: "border-border bg-transparent text-primary"
			}
		},
		defaultVariants: { variant: "default" }
	}
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
	VariantProps<typeof badgeStyles>;

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
	{ className, variant, ...rest },
	ref
) {
	return (
		<span
			ref={ref}
			className={cn(badgeStyles({ variant }), className)}
			{...rest}
		/>
	);
});

export { badgeStyles };
