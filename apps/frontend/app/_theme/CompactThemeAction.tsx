"use client";

import { SunMoon } from "lucide-react";

import { IconButton } from "../_ui/IconButton";
import { cn } from "../_ui/cn";
import { useTheme } from "./ThemeProvider";
import type { ThemeMode } from "./theme";

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
	system: "light",
	light: "dark",
	dark: "system"
};

const LABELS: Record<ThemeMode, string> = {
	light: "light",
	dark: "dark",
	system: "system"
};

/**
 * Compact header action that cycles the theme without consuming the width of
 * the full three-way preference control available in Settings.
 */
export function CompactThemeAction({ className }: { className?: string }) {
	const { mode, setMode } = useTheme();
	const next = NEXT_MODE[mode];

	return (
		<IconButton
			aria-label={`Theme: ${LABELS[mode]}. Switch to ${LABELS[next]}`}
			title={`Theme: ${LABELS[mode]}`}
			className={cn(className)}
			onClick={() => setMode(next)}
		>
			<SunMoon aria-hidden="true" />
		</IconButton>
	);
}
