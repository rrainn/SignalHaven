"use client";

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { BrandMark } from "../_layout/BrandMark";
import { CompactThemeAction } from "../_theme/CompactThemeAction";
import { Button } from "../_ui/Button";
import { Spinner } from "../_ui/Spinner";

/**
 * THESIS: Account access feels like opening a calm private broadcast deck.
 * OWN-WORLD: SignalHaven's mark, slate surfaces, system type, and Control Blue
 * extend unchanged; access adds focus, not a second visual identity.
 * STORY: Identify the local server, explain the single task, complete it, and
 * move directly into the guide or setup.
 * FIRST VIEWPORT: Brand, concise context, visible fields, one primary action,
 * and recovery remain present without scrolling on a phone.
 * FORM: Centered panel option 1; a narrow established-world extension with no
 * concept seed, decorative dashboard, gradient, or glass.
 */
export function AuthSurface(props: {
	title: string;
	description: string;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<main className="relative flex min-h-dvh items-center justify-center bg-background px-4 py-12 text-primary">
			<CompactThemeAction className="absolute right-4 top-4" />
			<section
				aria-labelledby="access-heading"
				className="w-full max-w-md rounded-lg border border-border bg-surface p-5 sm:p-6"
			>
				<div className="mb-6 flex items-center gap-3">
					<BrandMark className="h-12 w-12 shrink-0" />
					<div className="min-w-0">
						<p className="text-sm font-semibold tracking-[-0.025em]">
							SignalHaven
						</p>
						<p className="text-xs text-secondary">Private live TV and DVR</p>
					</div>
				</div>
				<div className="mb-6 space-y-2">
					<h1
						id="access-heading"
						className="text-2xl font-semibold tracking-[-0.025em] text-primary"
					>
						{props.title}
					</h1>
					<p className="text-sm leading-6 text-secondary">
						{props.description}
					</p>
				</div>
				{props.children}
				{props.footer ? (
					<div className="mt-6 border-t border-border pt-4 text-xs leading-5 text-secondary">
						{props.footer}
					</div>
				) : null}
			</section>
		</main>
	);
}

/** Keeps protected content absent while the server resolves account state. */
export function AuthCheckingSurface() {
	return (
		<AuthSurface
			title="Opening SignalHaven"
			description="Checking this server's account access."
		>
			<div className="flex min-h-24 items-center justify-center">
				<Spinner label="Checking account access…" />
			</div>
		</AuthSurface>
	);
}

/** Makes an unreachable auth service recoverable without leaking app content. */
export function AuthUnavailableSurface(props: {
	error: Error;
	onRetry: () => Promise<void>;
}) {
	return (
		<AuthSurface
			title="SignalHaven is unavailable"
			description="Account access could not be checked, so the application remains locked."
		>
			<div className="space-y-4">
				<div
					role="alert"
					className="flex gap-3 rounded-md bg-danger/10 p-3 text-sm text-danger"
				>
					<AlertTriangle
						aria-hidden="true"
						className="mt-0.5 h-4 w-4 shrink-0"
					/>
					<p>{props.error.message}</p>
				</div>
				<Button block onClick={() => void props.onRetry()}>
					Try again
				</Button>
			</div>
		</AuthSurface>
	);
}
