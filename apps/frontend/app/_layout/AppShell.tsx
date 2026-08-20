"use client";

import {
	CalendarClock,
	CalendarDays,
	Library,
	ListVideo,
	Settings,
	Wrench,
	type LucideIcon
} from "lucide-react";
import { usePathname } from "next/navigation";

import { usePreferencesOptional } from "../_preferences/PreferencesProvider";
import { GlobalSearch } from "../_search/GlobalSearch";
import { CompactThemeAction } from "../_theme/CompactThemeAction";
import { ThemeToggle } from "../_theme/ThemeToggle";
import { cn } from "../_ui/cn";
import { useAdvancedModeOptional } from "../_advanced/AdvancedModeProvider";
import { AccountControls } from "../_auth/AccountControls";
import { useAuth } from "../_auth/AuthProvider";
import { Button } from "../_ui/Button";

import { BrandMark } from "./BrandMark";
import { IntentPrefetchLink } from "./SmartLink";

/**
 * Mobile-first app shell.
 *
 * - On mobile (< md): the top bar shows just the brand; primary navigation
 *   is rendered as a bottom nav for thumb reach.
 * - On desktop (≥ md): primary navigation is inlined into the top app bar
 *   and the bottom nav is hidden.
 */

export type NavItem = {
	href: string;
	label: string;
	/** Shorter mobile label that remains readable at narrow phone widths. */
	shortLabel?: string;
	/** Meaningful mobile icon from the project's shared Lucide icon set. */
	icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
	{ href: "/guide", label: "Guide", shortLabel: "Guide", icon: CalendarDays },
	{
		href: "/channels",
		label: "Channels",
		shortLabel: "Channels",
		icon: ListVideo
	},
	{
		href: "/scheduler",
		label: "Scheduler",
		shortLabel: "Schedule",
		icon: CalendarClock
	},
	{
		href: "/recordings",
		label: "Recordings",
		shortLabel: "Library",
		icon: Library
	},
	{
		href: "/settings",
		label: "Settings",
		shortLabel: "Settings",
		icon: Settings
	}
];

/**
 * Maps detail and playback routes back to the top-level destination that owns
 * them so navigation state remains stable throughout a user flow.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
	if (href === "/guide") {
		return (
			pathname === "/guide" ||
			pathname.startsWith("/guide/") ||
			pathname.startsWith("/watch/") ||
			pathname.startsWith("/programs/")
		);
	}
	return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
	const preferences = usePreferencesOptional();
	const advancedMode = useAdvancedModeOptional();
	const auth = useAuth();
	const pathname = usePathname();
	const isAdmin =
		auth.state.status === "signed-in" && auth.state.user.role === "admin";
	const permittedItems = isAdmin
		? NAV_ITEMS
		: NAV_ITEMS.filter((item) => item.href !== "/settings");
	const navItems =
		advancedMode?.enabled && isAdmin
			? [
					...permittedItems,
					{
						href: "/advanced",
						label: "Advanced",
						shortLabel: "Tools",
						icon: Wrench
					}
				]
			: permittedItems;

	return (
		<div className="flex min-h-dvh flex-col bg-background text-primary">
			{/* Skip link — first focusable element so keyboard users can bypass nav. */}
			<a
				href="#main-content"
				className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-foreground"
			>
				Skip to content
			</a>

			<TopAppBar pathname={pathname} items={navItems} />

			{preferences?.error ? (
				<div
					role="alert"
					data-testid="preferences-error"
					className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
				>
					<div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2">
						<span>
							{preferences.status === "error"
								? "Personal preferences are unavailable."
								: "A preference change could not be saved."}{" "}
							{preferences.error.message}
						</span>
						{preferences.status === "error" ? (
							<Button
								size="sm"
								variant="outline"
								onClick={() => void preferences.retry()}
							>
								Try again
							</Button>
						) : null}
					</div>
				</div>
			) : null}

			<main
				id="main-content"
				// Add bottom padding on mobile so the fixed bottom nav doesn't cover
				// page content; the nav is hidden at md+.
				className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-4 md:pb-8 md:pt-6"
			>
				{children}
			</main>

			<BottomNav pathname={pathname} items={navItems} />
		</div>
	);
}

function TopAppBar({
	pathname,
	items
}: {
	pathname: string;
	items: readonly NavItem[];
}) {
	return (
		<header className="sticky top-0 z-30 border-b border-border bg-surface/80 backdrop-blur">
			<div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
				<IntentPrefetchLink
					href="/"
					aria-label="SignalHaven home"
					className="group flex shrink-0 items-center gap-2 text-base font-semibold tracking-[-0.025em] text-primary"
				>
					<BrandMark className="h-8 w-8 transition-transform duration-200 group-hover:scale-[1.04] motion-reduce:transition-none" />
					<span className="hidden sm:inline">SignalHaven</span>
				</IntentPrefetchLink>

				<nav
					aria-label="Primary"
					className="hidden flex-1 items-center gap-1 md:flex"
				>
					{items.map((item) => (
						<IntentPrefetchLink
							key={item.href}
							href={item.href}
							aria-current={
								isNavItemActive(pathname, item.href) ? "page" : undefined
							}
							className={cn(
								"rounded px-3 py-2 text-sm text-secondary hover:bg-surface-muted hover:text-primary",
								isNavItemActive(pathname, item.href) &&
									"bg-surface-muted font-medium text-primary"
							)}
						>
							{item.label}
						</IntentPrefetchLink>
					))}
				</nav>

				<div className="ml-auto flex items-center gap-1">
					<GlobalSearch />
					<ThemeToggle className="hidden md:inline-flex" />
					<CompactThemeAction className="md:hidden" />
					<AccountControls />
				</div>
			</div>
		</header>
	);
}

function BottomNav({
	pathname,
	items
}: {
	pathname: string;
	items: readonly NavItem[];
}) {
	return (
		<nav
			aria-label="Primary"
			// `pb-[env(safe-area-inset-bottom)]` keeps the nav above the home
			// indicator on iOS standalone PWAs.
			className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
			data-testid="bottom-nav"
		>
			<ul className="mx-auto flex w-full max-w-6xl items-stretch justify-around">
				{items.map((item) => {
					const active = isNavItemActive(pathname, item.href);
					const Icon = item.icon;
					return (
						<li key={item.href} className="min-w-0 flex-1">
							<IntentPrefetchLink
								href={item.href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[0.6875rem] text-secondary hover:text-primary min-[390px]:text-xs",
									active && "font-medium text-accent"
								)}
							>
								<Icon
									aria-hidden="true"
									data-testid="nav-icon"
									className="h-4 w-4"
								/>
								<span className="max-w-full truncate">
									{item.shortLabel ?? item.label}
								</span>
							</IntentPrefetchLink>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
