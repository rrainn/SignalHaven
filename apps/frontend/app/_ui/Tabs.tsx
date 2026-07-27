"use client";

import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ElementRef
} from "react";
import * as RadixTabs from "@radix-ui/react-tabs";

import { cn } from "./cn";

/**
 * Tabs — accessible tab pattern built on `@radix-ui/react-tabs`.
 *
 * Provides automatic ARIA wiring, keyboard navigation (Left/Right/Home/End),
 * and roving tabindex. Subcomponents mirror Radix's API.
 */
export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef<
	ElementRef<typeof RadixTabs.List>,
	ComponentPropsWithoutRef<typeof RadixTabs.List>
>(function TabsList({ className, ...rest }, ref) {
	return (
		<RadixTabs.List
			ref={ref}
			data-density-control="tabs-list"
			className={cn(
				"inline-flex h-10 items-center justify-start gap-1 rounded-md bg-surface-muted p-1 text-secondary",
				className
			)}
			{...rest}
		/>
	);
});

export const TabsTrigger = forwardRef<
	ElementRef<typeof RadixTabs.Trigger>,
	ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
>(function TabsTrigger({ className, ...rest }, ref) {
	return (
		<RadixTabs.Trigger
			ref={ref}
			data-density-control="tabs-trigger"
			className={cn(
				"inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium",
				"transition-colors motion-reduce:transition-none",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"disabled:pointer-events-none disabled:opacity-50",
				"data-[state=active]:bg-surface data-[state=active]:text-primary data-[state=active]:shadow",
				className
			)}
			{...rest}
		/>
	);
});

export const TabsContent = forwardRef<
	ElementRef<typeof RadixTabs.Content>,
	ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(function TabsContent({ className, ...rest }, ref) {
	return (
		<RadixTabs.Content
			ref={ref}
			className={cn(
				"mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				className
			)}
			{...rest}
		/>
	);
});
