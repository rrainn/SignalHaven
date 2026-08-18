"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

import { IconButton } from "../_ui/IconButton";
import { Spinner } from "../_ui/Spinner";
import { SmartLink } from "../_layout/SmartLink";
import { useAuth } from "./AuthProvider";

/** Keeps the active local identity and session exit visible in compact chrome. */
export function AccountControls() {
	const auth = useAuth();
	const [signingOut, setSigningOut] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (auth.state.status !== "signed-in") return null;

	const signOut = async () => {
		setSigningOut(true);
		setError(null);
		try {
			await auth.signOut();
		} catch {
			setError("Sign out failed. Check your connection and try again.");
		} finally {
			setSigningOut(false);
		}
	};

	return (
		<div className="relative flex min-w-0 items-center gap-1">
			<SmartLink
				href="/preferences"
				aria-label={`Preferences for ${auth.state.user.username}`}
				className="max-w-20 truncate rounded px-1 py-1 text-xs font-medium text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				title={auth.state.user.username}
				data-testid="active-username"
			>
				{auth.state.user.username}
			</SmartLink>
			<IconButton
				variant="ghost"
				size="sm"
				aria-label={`Sign out ${auth.state.user.username}`}
				title="Sign out"
				disabled={signingOut}
				onClick={() => void signOut()}
			>
				{signingOut ? (
					<Spinner aria-hidden="true" className="h-4 w-4" />
				) : (
					<LogOut aria-hidden="true" />
				)}
			</IconButton>
			{error ? (
				<div
					role="alert"
					className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-64 rounded-md border border-danger/40 bg-surface p-3 text-xs leading-5 text-danger shadow-lg"
				>
					{error}
				</div>
			) : null}
		</div>
	);
}
