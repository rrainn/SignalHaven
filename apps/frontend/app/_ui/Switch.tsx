"use client";

import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ElementRef
} from "react";
import * as RadixSwitch from "@radix-ui/react-switch";

import { cn } from "./cn";

export const Switch = forwardRef<
	ElementRef<typeof RadixSwitch.Root>,
	ComponentPropsWithoutRef<typeof RadixSwitch.Root>
>(function Switch({ className, ...rest }, ref) {
	return (
		<RadixSwitch.Root
			ref={ref}
			className={cn(
				"inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
				"transition-colors motion-reduce:transition-none",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"disabled:cursor-not-allowed disabled:opacity-50",
				"data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-muted",
				className
			)}
			{...rest}
		>
			<RadixSwitch.Thumb
				className={cn(
					"pointer-events-none block h-5 w-5 rounded-full bg-white shadow-md ring-0",
					"transition-transform motion-reduce:transition-none",
					"data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
				)}
			/>
		</RadixSwitch.Root>
	);
});
