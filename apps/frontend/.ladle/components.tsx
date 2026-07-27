import type { GlobalProvider } from "@ladle/react";
import { useEffect } from "react";

import { ThemeProvider } from "../app/_theme/ThemeProvider";
import { ToastProvider, ToastViewport } from "../app/_ui/Toast";
import { TooltipProvider } from "../app/_ui/Tooltip";

import "../app/globals.css";

/**
 * Ladle global decorator.
 *
 * - Wraps every story in <ThemeProvider> + Radix providers required by
 *   tooltips/toasts so individual stories don't have to.
 * - Mirrors Ladle's built-in `theme` toggle onto the `<html>.dark` class
 *   that our U1 tokens key off, so light/dark previews work out of the box.
 */
export const Provider: GlobalProvider = ({ children, globalState }) => {
	useEffect(() => {
		const root = document.documentElement;
		if (globalState.theme === "dark") {
			root.classList.add("dark");
			root.style.colorScheme = "dark";
		} else {
			root.classList.remove("dark");
			root.style.colorScheme = "light";
		}
	}, [globalState.theme]);

	return (
		<ThemeProvider>
			<TooltipProvider>
				<ToastProvider>
					<div className="bg-background p-6 text-primary">{children}</div>
					<ToastViewport />
				</ToastProvider>
			</TooltipProvider>
		</ThemeProvider>
	);
};
