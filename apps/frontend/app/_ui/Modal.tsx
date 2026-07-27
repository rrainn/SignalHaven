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
 * Modal — accessible dialog built on `@radix-ui/react-dialog`.
 *
 * Provides:
 *   - Focus trap (focus stays inside the modal while open)
 *   - Escape closes the dialog
 *   - Outside click closes (via overlay)
 *   - Restores focus to the trigger on close
 *   - `aria-modal`, `role="dialog"`, and labelled-by/described-by wiring via
 *     `<ModalTitle>` and `<ModalDescription>`
 *
 * Pattern:
 *   <Modal>
 *     <ModalTrigger asChild><Button>Open</Button></ModalTrigger>
 *     <ModalContent>
 *       <ModalHeader>
 *         <ModalTitle>Heading</ModalTitle>
 *         <ModalDescription>Body</ModalDescription>
 *       </ModalHeader>
 *       …
 *     </ModalContent>
 *   </Modal>
 */
export const Modal = RadixDialog.Root;
export const ModalTrigger = RadixDialog.Trigger;
export const ModalClose = RadixDialog.Close;
export const ModalPortal = RadixDialog.Portal;

export const ModalOverlay = forwardRef<
	ElementRef<typeof RadixDialog.Overlay>,
	ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(function ModalOverlay({ className, ...rest }, ref) {
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

export type ModalContentProps = ComponentPropsWithoutRef<
	typeof RadixDialog.Content
> & {
	/** Render an `X` close button in the top-right (default `true`). */
	showCloseButton?: boolean;
	children?: ReactNode;
};

export const ModalContent = forwardRef<
	ElementRef<typeof RadixDialog.Content>,
	ModalContentProps
>(function ModalContent(
	{ className, children, showCloseButton = true, ...rest },
	ref
) {
	return (
		<ModalPortal>
			<ModalOverlay />
			<RadixDialog.Content
				ref={ref}
				className={cn(
					"fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-surface p-6 text-primary shadow-xl",
					"data-[state=open]:motion-safe:animate-in data-[state=open]:motion-safe:fade-in-0 data-[state=open]:motion-safe:zoom-in-95",
					"data-[state=closed]:motion-safe:animate-out data-[state=closed]:motion-safe:fade-out-0 data-[state=closed]:motion-safe:zoom-out-95",
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
							aria-label="Close dialog"
							className="absolute right-3 top-3"
						>
							<X aria-hidden="true" />
						</IconButton>
					</RadixDialog.Close>
				) : null}
			</RadixDialog.Content>
		</ModalPortal>
	);
});

export function ModalHeader({
	className,
	...rest
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn("flex flex-col gap-1.5 text-left", className)}
			{...rest}
		/>
	);
}

export function ModalFooter({
	className,
	...rest
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className
			)}
			{...rest}
		/>
	);
}

export const ModalTitle = forwardRef<
	ElementRef<typeof RadixDialog.Title>,
	ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function ModalTitle({ className, ...rest }, ref) {
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

export const ModalDescription = forwardRef<
	ElementRef<typeof RadixDialog.Description>,
	ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function ModalDescription({ className, ...rest }, ref) {
	return (
		<RadixDialog.Description
			ref={ref}
			className={cn("text-sm text-secondary", className)}
			{...rest}
		/>
	);
});
