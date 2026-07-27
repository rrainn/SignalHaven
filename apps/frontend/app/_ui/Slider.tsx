"use client";

import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ElementRef
} from "react";
import * as RadixSlider from "@radix-ui/react-slider";

import { cn } from "./cn";

type SliderProps = ComponentPropsWithoutRef<typeof RadixSlider.Root> & {
	/** Supplies distinct accessible names when a slider renders multiple thumbs. */
	thumbLabels?: readonly string[];
};

export const Slider = forwardRef<
	ElementRef<typeof RadixSlider.Root>,
	SliderProps
>(function Slider(
	{
		className,
		thumbLabels,
		"aria-label": ariaLabel,
		"aria-labelledby": ariaLabelledBy,
		...rest
	},
	ref
) {
	// Render one Thumb per active value (supports both controlled and
	// uncontrolled modes, including range sliders with two thumbs).
	const thumbValues = rest.value ?? rest.defaultValue ?? [0];
	return (
		<RadixSlider.Root
			ref={ref}
			className={cn(
				"relative flex w-full touch-none select-none items-center",
				"data-[disabled]:opacity-50",
				className
			)}
			{...rest}
		>
			<RadixSlider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-muted">
				<RadixSlider.Range className="absolute h-full bg-accent" />
			</RadixSlider.Track>
			{thumbValues.map((_, i) => (
				<RadixSlider.Thumb
					key={i}
					aria-label={thumbLabels?.[i] ?? ariaLabel}
					aria-labelledby={thumbLabels?.[i] ? undefined : ariaLabelledBy}
					className={cn(
						"block h-6 w-6 rounded-full border-2 border-accent bg-surface shadow",
						"transition-colors motion-reduce:transition-none",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
						"disabled:pointer-events-none"
					)}
				/>
			))}
		</RadixSlider.Root>
	);
});
