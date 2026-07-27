"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { IconButton } from "../_ui/IconButton";

import { SearchModal } from "./SearchModal";

/**
 * Mounts the global search modal + the Cmd/Ctrl-K hotkey listener and
 * renders the trigger button. Lives in the app shell so the hotkey is
 * always armed regardless of the active route.
 */
export function GlobalSearch() {
	const [open, setOpen] = useState(false);

	const onTriggerClick = useCallback(() => setOpen(true), []);

	useEffect(() => {
		function handler(event: KeyboardEvent) {
			// Cmd/Ctrl + K opens the search modal regardless of focus
			// location (matches the de-facto convention popularised by
			// Spotlight, VSCode, GitHub, …).
			const isMod = event.metaKey || event.ctrlKey;
			if (isMod && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setOpen((prev) => !prev);
			}
		}
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	return (
		<>
			<IconButton
				size="sm"
				variant="ghost"
				aria-label="Search (Ctrl+K)"
				title="Search (Ctrl+K)"
				onClick={onTriggerClick}
				data-testid="global-search-trigger"
			>
				<Search aria-hidden="true" />
			</IconButton>

			{/*
        Mount the modal lazily so its `useRouter` call doesn't run
        outside an App Router context (e.g. in unit tests that render
        the AppShell directly). The Radix open/close animation
        re-runs on every mount, which is the desired UX here.
      */}
			{open ? <SearchModal open={open} onOpenChange={setOpen} /> : null}
		</>
	);
}
