import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Tailwind config for SignalHaven frontend.
 *
 * Color tokens are exposed as semantic names (e.g. `bg-surface`,
 * `text-primary`) backed by CSS variables defined in `app/globals.css`.
 * That indirection lets us swap themes (light / dark / future custom
 * palettes) by toggling a single class on `<html>` without touching the
 * Tailwind output.
 */
const config: Config = {
	content: ["./app/**/*.{ts,tsx}", "./.ladle/**/*.{ts,tsx}"],
	// Theme is toggled via the `class` strategy: `<html class="dark">` enables
	// the dark token overrides defined in globals.css.
	darkMode: "class",
	theme: {
		extend: {
			colors: {
				// Surfaces
				background: "rgb(var(--color-background) / <alpha-value>)",
				surface: "rgb(var(--color-surface) / <alpha-value>)",
				"surface-muted": "rgb(var(--color-surface-muted) / <alpha-value>)",
				// Text
				primary: "rgb(var(--color-text-primary) / <alpha-value>)",
				secondary: "rgb(var(--color-text-secondary) / <alpha-value>)",
				muted: "rgb(var(--color-text-muted) / <alpha-value>)",
				// Accent / interactive
				accent: "rgb(var(--color-accent) / <alpha-value>)",
				"accent-foreground":
					"rgb(var(--color-accent-foreground) / <alpha-value>)",
				// Live broadcast state remains distinct from control and focus blue.
				live: "rgb(var(--color-live) / <alpha-value>)",
				"live-foreground": "rgb(var(--color-live-foreground) / <alpha-value>)",
				// Borders / lines
				border: "rgb(var(--color-border) / <alpha-value>)",
				// Status
				danger: "rgb(var(--color-danger) / <alpha-value>)",
				success: "rgb(var(--color-success) / <alpha-value>)"
			}
		}
	},
	plugins: [animate]
};

export default config;
