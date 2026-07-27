"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { useTheme } from "./ThemeProvider";
import { THEME_MODES, type ThemeMode } from "./theme";

const OPTIONS: Record<ThemeMode, { icon: LucideIcon; label: string }> = {
	light: { icon: Sun, label: "Light" },
	system: { icon: Monitor, label: "System" },
	dark: { icon: Moon, label: "Dark" }
};

/**
 * Renders the three theme modes as a compact, accessible segmented control.
 */
export function ThemeToggle({ className }: { className?: string }) {
	const { mode, setMode } = useTheme();

	return (
		<div
			role="group"
			aria-label="Theme"
			className={
				"inline-flex items-center gap-0.5 rounded-full border border-border bg-surface-muted p-0.5 " +
				(className ?? "")
			}
		>
			{THEME_MODES.map((themeMode) => {
				const active = mode === themeMode;
				const { icon: Icon, label } = OPTIONS[themeMode];

				return (
					<button
						key={themeMode}
						type="button"
						aria-label={`${label} theme`}
						aria-pressed={active}
						title={`${label} theme`}
						data-testid={`theme-toggle-${themeMode}`}
						onClick={() => setMode(themeMode)}
						className={
							"grid h-7 w-7 place-items-center rounded-full transition-colors " +
							(active
								? "bg-accent text-accent-foreground"
								: "text-secondary hover:text-primary")
						}
					>
						<Icon aria-hidden="true" className="h-4 w-4" />
					</button>
				);
			})}
		</div>
	);
}
