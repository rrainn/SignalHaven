import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "./cn";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
	function Card({ className, ...rest }, ref) {
		return (
			<div
				ref={ref}
				className={cn(
					"rounded-lg border border-border bg-surface text-primary shadow-sm",
					className
				)}
				{...rest}
			/>
		);
	}
);

export const CardHeader = forwardRef<
	HTMLDivElement,
	HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...rest }, ref) {
	return (
		<div
			ref={ref}
			data-density-section="header"
			className={cn("flex flex-col gap-1.5 p-4 sm:p-6", className)}
			{...rest}
		/>
	);
});

export const CardTitle = forwardRef<
	HTMLHeadingElement,
	HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...rest }, ref) {
	return (
		<h3
			ref={ref}
			className={cn(
				"text-base font-semibold leading-none tracking-tight",
				className
			)}
			{...rest}
		/>
	);
});

export const CardDescription = forwardRef<
	HTMLParagraphElement,
	HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...rest }, ref) {
	return (
		<p
			ref={ref}
			className={cn("text-sm text-secondary", className)}
			{...rest}
		/>
	);
});

export const CardContent = forwardRef<
	HTMLDivElement,
	HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...rest }, ref) {
	return (
		<div
			ref={ref}
			data-density-section="content"
			className={cn("p-4 pt-0 sm:p-6 sm:pt-0", className)}
			{...rest}
		/>
	);
});

export const CardFooter = forwardRef<
	HTMLDivElement,
	HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...rest }, ref) {
	return (
		<div
			ref={ref}
			data-density-section="footer"
			className={cn("flex items-center p-4 pt-0 sm:p-6 sm:pt-0", className)}
			{...rest}
		/>
	);
});
