"use client";

import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ElementRef
} from "react";
import * as RadixToast from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn";

/**
 * Toast — accessible transient notification built on `@radix-ui/react-toast`.
 *
 * `<ToastProvider>` (Radix) wires up an `aria-live` region; consumers should
 * wrap their app once at the root. The `<ToastViewport>` component places the
 * fixed region where toasts render.
 *
 * Each `<Toast>` exposes `role="status"` (or `role="alert"` for the
 * `destructive` variant) automatically via Radix.
 */
export const ToastProvider = RadixToast.Provider;

export const ToastViewport = forwardRef<
	ElementRef<typeof RadixToast.Viewport>,
	ComponentPropsWithoutRef<typeof RadixToast.Viewport>
>(function ToastViewport({ className, ...rest }, ref) {
	return (
		<RadixToast.Viewport
			ref={ref}
			className={cn(
				"fixed bottom-0 right-0 z-[100] flex max-h-screen w-full max-w-sm flex-col-reverse gap-2 p-4 outline-none sm:bottom-4 sm:right-4",
				className
			)}
			{...rest}
		/>
	);
});

const toastStyles = cva(
	[
		"group pointer-events-auto relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-md border p-4 pr-8 shadow-lg",
		"data-[state=open]:motion-safe:animate-in data-[state=open]:motion-safe:slide-in-from-bottom-full",
		"data-[state=closed]:motion-safe:animate-out data-[state=closed]:motion-safe:fade-out-80",
		"data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
		"data-[swipe=cancel]:translate-x-0",
		"data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=end]:motion-safe:animate-out"
	],
	{
		variants: {
			variant: {
				default: "bg-surface text-primary border-border",
				success: "bg-surface text-primary border-success",
				destructive: "bg-surface text-primary border-danger"
			}
		},
		defaultVariants: { variant: "default" }
	}
);

export type ToastProps = ComponentPropsWithoutRef<typeof RadixToast.Root> &
	VariantProps<typeof toastStyles>;

export const Toast = forwardRef<ElementRef<typeof RadixToast.Root>, ToastProps>(
	function Toast({ className, variant, ...rest }, ref) {
		return (
			<RadixToast.Root
				ref={ref}
				className={cn(toastStyles({ variant }), className)}
				{...rest}
			/>
		);
	}
);

export const ToastTitle = forwardRef<
	ElementRef<typeof RadixToast.Title>,
	ComponentPropsWithoutRef<typeof RadixToast.Title>
>(function ToastTitle({ className, ...rest }, ref) {
	return (
		<RadixToast.Title
			ref={ref}
			className={cn("text-sm font-semibold", className)}
			{...rest}
		/>
	);
});

export const ToastDescription = forwardRef<
	ElementRef<typeof RadixToast.Description>,
	ComponentPropsWithoutRef<typeof RadixToast.Description>
>(function ToastDescription({ className, ...rest }, ref) {
	return (
		<RadixToast.Description
			ref={ref}
			className={cn("text-sm text-secondary", className)}
			{...rest}
		/>
	);
});

export const ToastAction = forwardRef<
	ElementRef<typeof RadixToast.Action>,
	ComponentPropsWithoutRef<typeof RadixToast.Action>
>(function ToastAction({ className, ...rest }, ref) {
	return (
		<RadixToast.Action
			ref={ref}
			className={cn(
				"inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border bg-transparent px-3 text-xs font-medium text-primary",
				"transition-colors motion-reduce:transition-none hover:bg-surface-muted",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				className
			)}
			{...rest}
		/>
	);
});

export const ToastClose = forwardRef<
	ElementRef<typeof RadixToast.Close>,
	ComponentPropsWithoutRef<typeof RadixToast.Close>
>(function ToastClose({ className, ...rest }, ref) {
	return (
		<RadixToast.Close
			ref={ref}
			aria-label={rest["aria-label"] ?? "Close notification"}
			className={cn(
				"absolute right-2 top-2 rounded-md p-1 text-muted opacity-70",
				"transition-opacity motion-reduce:transition-none hover:opacity-100",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				className
			)}
			toast-close=""
			{...rest}
		>
			<span aria-hidden="true">×</span>
		</RadixToast.Close>
	);
});
