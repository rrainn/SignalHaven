"use client";

import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ElementRef,
	type ReactNode
} from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "./cn";

/**
 * Select — accessible dropdown built on `@radix-ui/react-select`.
 *
 * Re-exports a set of styled subcomponents that mirror Radix's API, plus a
 * convenience `<Select>` root that simply forwards to `RadixSelect.Root`.
 *
 * Usage:
 *   <Select value={v} onValueChange={setV}>
 *     <SelectTrigger><SelectValue placeholder="Pick…" /></SelectTrigger>
 *     <SelectContent>
 *       <SelectItem value="a">A</SelectItem>
 *     </SelectContent>
 *   </Select>
 */
export const Select = RadixSelect.Root;
export const SelectGroup = RadixSelect.Group;
export const SelectValue = RadixSelect.Value;

export const SelectTrigger = forwardRef<
	ElementRef<typeof RadixSelect.Trigger>,
	ComponentPropsWithoutRef<typeof RadixSelect.Trigger>
>(function SelectTrigger({ className, children, ...rest }, ref) {
	return (
		<RadixSelect.Trigger
			ref={ref}
			data-density-control="select"
			className={cn(
				"inline-flex h-10 w-full items-center justify-between rounded-md border border-border bg-surface px-3 text-sm text-primary",
				"placeholder:text-muted",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"disabled:cursor-not-allowed disabled:opacity-60",
				"data-[placeholder]:text-muted",
				className
			)}
			{...rest}
		>
			{children}
			<RadixSelect.Icon asChild>
				<ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
			</RadixSelect.Icon>
		</RadixSelect.Trigger>
	);
});

export const SelectContent = forwardRef<
	ElementRef<typeof RadixSelect.Content>,
	ComponentPropsWithoutRef<typeof RadixSelect.Content>
>(function SelectContent(
	{ className, children, position = "popper", ...rest },
	ref
) {
	return (
		<RadixSelect.Portal>
			<RadixSelect.Content
				ref={ref}
				position={position}
				className={cn(
					"relative z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-surface text-primary shadow-lg",
					// Subtle entry animation – respects reduced motion (Tailwind's
					// motion-reduce variant disables the keyframes for Radix's
					// data-[state] selectors below).
					"data-[state=open]:motion-safe:animate-in data-[state=open]:motion-safe:fade-in-0 data-[state=open]:motion-safe:zoom-in-95",
					"data-[state=closed]:motion-safe:animate-out data-[state=closed]:motion-safe:fade-out-0 data-[state=closed]:motion-safe:zoom-out-95",
					position === "popper" &&
						"data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
					className
				)}
				{...rest}
			>
				<RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center">
					<ChevronUp className="h-4 w-4" aria-hidden="true" />
				</RadixSelect.ScrollUpButton>
				<RadixSelect.Viewport className="p-1">{children}</RadixSelect.Viewport>
				<RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center">
					<ChevronDown className="h-4 w-4" aria-hidden="true" />
				</RadixSelect.ScrollDownButton>
			</RadixSelect.Content>
		</RadixSelect.Portal>
	);
});

export const SelectLabel = forwardRef<
	ElementRef<typeof RadixSelect.Label>,
	ComponentPropsWithoutRef<typeof RadixSelect.Label>
>(function SelectLabel({ className, ...rest }, ref) {
	return (
		<RadixSelect.Label
			ref={ref}
			className={cn("px-2 py-1.5 text-xs font-semibold text-muted", className)}
			{...rest}
		/>
	);
});

export type SelectItemProps = ComponentPropsWithoutRef<
	typeof RadixSelect.Item
> & {
	children: ReactNode;
};

export const SelectItem = forwardRef<
	ElementRef<typeof RadixSelect.Item>,
	SelectItemProps
>(function SelectItem({ className, children, ...rest }, ref) {
	return (
		<RadixSelect.Item
			ref={ref}
			className={cn(
				"relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none",
				"data-[highlighted]:bg-surface-muted data-[highlighted]:text-primary",
				"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className
			)}
			{...rest}
		>
			<span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
				<RadixSelect.ItemIndicator>
					<Check className="h-4 w-4" aria-hidden="true" />
				</RadixSelect.ItemIndicator>
			</span>
			<RadixSelect.ItemText>{children}</RadixSelect.ItemText>
		</RadixSelect.Item>
	);
});

export const SelectSeparator = forwardRef<
	ElementRef<typeof RadixSelect.Separator>,
	ComponentPropsWithoutRef<typeof RadixSelect.Separator>
>(function SelectSeparator({ className, ...rest }, ref) {
	return (
		<RadixSelect.Separator
			ref={ref}
			className={cn("my-1 h-px bg-border", className)}
			{...rest}
		/>
	);
});
