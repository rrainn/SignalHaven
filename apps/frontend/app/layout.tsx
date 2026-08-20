import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Suspense, type ReactNode } from "react";

import "./globals.css";
import { AuthGate } from "./_auth/AuthGate";
import { AuthProvider } from "./_auth/AuthProvider";
import { AuthCheckingSurface } from "./_auth/AuthSurface";
import { loadServerAuthBootstrap } from "./_auth/server-auth-bootstrap";
import { ServiceWorkerRegistrar } from "./_pwa/ServiceWorkerRegistrar";
import { appearanceBootstrapScript } from "./_settings/appearance";
import { themeBootstrapScript } from "./_theme/theme";
import { ThemeProvider } from "./_theme/ThemeProvider";

export const metadata: Metadata = {
	title: {
		default: "SignalHaven",
		template: "%s · SignalHaven"
	},
	description: "SignalHaven — over-the-air TV streaming and DVR.",
	applicationName: "SignalHaven",
	manifest: "/manifest.webmanifest",
	appleWebApp: {
		capable: true,
		title: "SignalHaven",
		statusBarStyle: "black-translucent"
	},
	icons: {
		icon: [
			{ url: "/favicon.ico", sizes: "48x48" },
			{ url: "/icons/favicon.svg", type: "image/svg+xml" },
			{ url: "/icons/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
			{ url: "/icons/icon-512.svg", sizes: "512x512", type: "image/svg+xml" }
		],
		shortcut: ["/favicon.ico"],
		apple: [
			{
				url: "/icons/apple-touch-icon.png",
				sizes: "180x180",
				type: "image/png"
			}
		]
	}
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	// The themeColor list lets the browser chrome match the active palette in
	// both light and dark modes (Safari, Chrome on Android).
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#ffffff" },
		{ media: "(prefers-color-scheme: dark)", color: "#0b0e16" }
	]
};

// Account-owned HTML must be resolved per request and must never enter a shared cache.
export const dynamic = "force-dynamic";

type RootLayoutProps = {
	children: ReactNode;
};

export default async function RootLayout({ children }: RootLayoutProps) {
	// Playwright owns API behavior inside each browser page, which cannot
	// intercept server-side fetches made before that page exists.
	const usesBrowserApiMocks =
		process.env.SIGNALHAVEN_E2E_CLIENT_API_MOCKS === "1";
	const initialBootstrap = usesBrowserApiMocks
		? undefined
		: await loadServerAuthBootstrap({
				cookie: (await headers()).get("cookie")
			});

	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/*
				 * Blocking inline script that sets the theme class on <html> *before*
				 * the body renders. Prevents a flash of the wrong palette on first
				 * paint. The script content is statically known and contains no
				 * user input — it cannot be controlled by request data.
				 */}
				<script
					// The script body is a static literal — no user input, no XSS risk.
					dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
				/>
				{/*
				 * Same pattern as the theme bootstrap above: applies the user's
				 * density / animation choice to <html> *before* React hydrates so
				 * the layout doesn't reflow into the chosen density on first paint.
				 */}
				<script
					// Static literal; no user input.
					dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript }}
				/>
			</head>
			<body className="antialiased">
				<ThemeProvider>
					<AuthProvider {...(initialBootstrap ? { initialBootstrap } : {})}>
						<Suspense fallback={<AuthCheckingSurface />}>
							<AuthGate>{children}</AuthGate>
						</Suspense>
					</AuthProvider>
				</ThemeProvider>
				<ServiceWorkerRegistrar />
			</body>
		</html>
	);
}
