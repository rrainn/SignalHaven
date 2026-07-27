"use client";

import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ElementRef,
	type ReactNode
} from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "./cn";
import { IconButton } from "./IconButton";

/**
 * Drawer — a side-anchored dialog (sheet) built on `@radix-ui/react-dialog`.
 *
 * Inherits all of Radix Dialog's a11y guarantees (focus trap, Escape, return
 * focus, `aria-modal`). The `side` prop controls which edge the drawer slides
 * in from.
 */
export const Drawer = RadixDialog.Root;
export const DrawerTrigger = RadixDialog.Trigger;
export const DrawerClose = RadixDialog.Close;
export const DrawerPortal = RadixDialog.Portal;

export const DrawerOverlay = forwardRef<
	ElementRef<typeof RadixDialog.Overlay>,
	ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(function DrawerOverlay({ className, ...rest }, ref) {
	return (
		<RadixDialog.Overlay
			ref={ref}
			className={cn(
				"fixed inset-0 z-40 bg-black/60",
				"data-[state=open]:motion-safe:animate-in data-[state=open]:motion-safe:fade-in-0",
				"data-[state=closed]:motion-safe:animate-out data-[state=closed]:motion-safe:fade-out-0",
				className
			)}
			{...rest}
		/>
	);
});

const sideStyles = {
	left: "inset-y-0 left-0 h-full w-3/4 max-w-sm border-r data-[state=open]:motion-safe:slide-in-from-left data-[state=closed]:motion-safe:slide-out-to-left",
	right:
		"inset-y-0 right-0 h-full w-3/4 max-w-sm border-l data-[state=open]:motion-safe:slide-in-from-right data-[state=closed]:motion-safe:slide-out-to-right",
	top: "inset-x-0 top-0 w-full border-b data-[state=open]:motion-safe:slide-in-from-top data-[state=closed]:motion-safe:slide-out-to-top",
	bottom:
		"inset-x-0 bottom-0 w-full border-t data-[state=open]:motion-safe:slide-in-from-bottom data-[state=closed]:motion-safe:slide-out-to-bottom"
} as const;

export type DrawerSide = keyof typeof sideStyles;

export type DrawerContentProps = ComponentPropsWithoutRef<
	typeof RadixDialog.Content
> & {
	side?: DrawerSide;
	showCloseButton?: boolean;
	children?: ReactNode;
};

export const DrawerContent = forwardRef<
	ElementRef<typeof RadixDialog.Content>,
	DrawerContentProps
>(function DrawerContent(
	{ className, children, side = "right", showCloseButton = true, ...rest },
	ref
) {
	return (
		<DrawerPortal>
			<DrawerOverlay />
			<RadixDialog.Content
				ref={ref}
				className={cn(
					"fixed z-50 flex flex-col gap-4 border-border bg-surface p-6 text-primary shadow-xl",
					"data-[state=open]:motion-safe:animate-in data-[state=closed]:motion-safe:animate-out",
					sideStyles[side],
					className
				)}
				{...rest}
			>
				{children}
				{showCloseButton ? (
					<RadixDialog.Close asChild>
						<IconButton
							size="sm"
							variant="ghost"
							aria-label="Close drawer"
							className="absolute right-3 top-3"
						>
							<X aria-hidden="true" />
						</IconButton>
					</RadixDialog.Close>
				) : null}
			</RadixDialog.Content>
		</DrawerPortal>
	);
});

export const DrawerTitle = forwardRef<
	ElementRef<typeof RadixDialog.Title>,
	ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function DrawerTitle({ className, ...rest }, ref) {
	return (
		<RadixDialog.Title
			ref={ref}
			className={cn(
				"text-lg font-semibold leading-none tracking-tight text-primary",
				className
			)}
			{...rest}
		/>
	);
});

export const DrawerDescription = forwardRef<
	ElementRef<typeof RadixDialog.Description>,
	ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function DrawerDescription({ className, ...rest }, ref) {
	return (
		<RadixDialog.Description
			ref={ref}
			className={cn("text-sm text-secondary", className)}
			{...rest}
		/>
	);
});
