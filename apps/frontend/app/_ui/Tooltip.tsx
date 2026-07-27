"use client";

import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ElementRef,
	type ReactNode
} from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";

import { cn } from "./cn";

export const TooltipProvider = RadixTooltip.Provider;
export const TooltipRoot = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;
export const TooltipPortal = RadixTooltip.Portal;

export const TooltipContent = forwardRef<
	ElementRef<typeof RadixTooltip.Content>,
	ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(function TooltipContent({ className, sideOffset = 4, ...rest }, ref) {
	return (
		<RadixTooltip.Content
			ref={ref}
			sideOffset={sideOffset}
			className={cn(
				"z-50 overflow-hidden rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-primary shadow-md",
				"data-[state=delayed-open]:motion-safe:animate-in data-[state=delayed-open]:motion-safe:fade-in-0 data-[state=delayed-open]:motion-safe:zoom-in-95",
				"data-[state=closed]:motion-safe:animate-out data-[state=closed]:motion-safe:fade-out-0 data-[state=closed]:motion-safe:zoom-out-95",
				className
			)}
			{...rest}
		/>
	);
});

/**
 * Convenience wrapper combining Provider + Root + Trigger + Content.
 *
 * For more advanced layouts (e.g. controlled state, portaling) compose the
 * individual primitives directly.
 */
export type TooltipProps = {
	content: ReactNode;
	children: ReactNode;
	delayDuration?: number;
	side?: "top" | "right" | "bottom" | "left";
};

export function Tooltip({
	content,
	children,
	delayDuration = 200,
	side = "top"
}: TooltipProps) {
	return (
		<TooltipProvider delayDuration={delayDuration}>
			<TooltipRoot>
				<TooltipTrigger asChild>{children}</TooltipTrigger>
				<TooltipPortal>
					<TooltipContent side={side}>{content}</TooltipContent>
				</TooltipPortal>
			</TooltipRoot>
		</TooltipProvider>
	);
}
