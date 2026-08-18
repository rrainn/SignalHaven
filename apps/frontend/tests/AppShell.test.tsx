import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { AppShell, NAV_ITEMS } from "../app/_layout/AppShell";
import { ThemeProvider } from "../app/_theme/ThemeProvider";

let pathname = "/guide";
let authRole: "admin" | "user" = "admin";

vi.mock("../app/_auth/AuthProvider", () => ({
	useAuth: () => ({
		state: {
			status: "signed-in" as const,
			user: {
				id: "00000000-0000-4000-8000-000000000001",
				username: authRole === "admin" ? "operator" : "viewer",
				role: authRole
			}
		},
		signOut: vi.fn()
	})
}));

vi.mock("next/navigation", () => ({
	usePathname: () => pathname
}));

function renderShell() {
	return render(
		<ThemeProvider>
			<AppShell>
				<p data-testid="content">Hello</p>
			</AppShell>
		</ThemeProvider>
	);
}

describe("AppShell", () => {
	beforeEach(() => {
		pathname = "/guide";
		authRole = "admin";
	});

	it("renders the brand, theme toggle, and primary navigation", () => {
		renderShell();
		const brandLink = screen.getByRole("link", { name: "SignalHaven home" });
		expect(within(brandLink).getByTestId("brand-mark")).toBeInTheDocument();
		expect(within(brandLink).getByText("SignalHaven")).toBeInTheDocument();
		expect(screen.getByRole("group", { name: /theme/i })).toBeInTheDocument();
		// Two nav landmarks: top app bar + bottom nav, both labelled "Primary".
		const navs = screen.getAllByRole("navigation", { name: /primary/i });
		expect(navs).toHaveLength(2);
	});

	it("renders every NAV_ITEM in both the top bar and bottom nav", () => {
		renderShell();
		const navs = screen.getAllByRole("navigation", { name: /primary/i });
		for (const nav of navs) {
			for (const item of NAV_ITEMS) {
				// Some labels differ between top bar (label) and bottom nav (shortLabel).
				const text =
					nav === navs[1] ? (item.shortLabel ?? item.label) : item.label;
				expect(within(nav).getByText(text)).toBeInTheDocument();
			}
		}
	});

	it("includes a skip-to-content link as the first focusable element", () => {
		renderShell();
		const skip = screen.getByText(/skip to content/i);
		expect(skip).toHaveAttribute("href", "#main-content");
	});

	it("renders children inside the main landmark with the skip target id", () => {
		renderShell();
		const main = screen.getByRole("main");
		expect(main).toHaveAttribute("id", "main-content");
		expect(within(main).getByTestId("content")).toHaveTextContent("Hello");
	});

	it.each([
		["/guide", "Guide"],
		["/watch/channel-id", "Guide"],
		["/programs/program-id", "Guide"],
		["/recordings/recording-id", "Recordings"],
		["/recordings/series/series-id", "Recordings"]
	])("marks %s as the %s destination", (route, destination) => {
		pathname = route;
		renderShell();

		const navs = screen.getAllByRole("navigation", { name: /primary/i });
		for (const [index, nav] of navs.entries()) {
			const mobileLabel =
				NAV_ITEMS.find((item) => item.label === destination)?.shortLabel ??
				destination;
			const active = within(nav).getByRole("link", {
				name: index === 1 ? mobileLabel : destination
			});
			expect(active).toHaveAttribute("aria-current", "page");
		}
	});

	it("uses labelled mobile navigation icons without placeholder glyphs", () => {
		renderShell();
		const mobileNav = screen.getByTestId("bottom-nav");

		expect(mobileNav).not.toHaveTextContent("•");
		expect(within(mobileNav).getAllByTestId("nav-icon")).toHaveLength(
			NAV_ITEMS.length
		);
	});

	it("shows the active identity and removes administrator destinations for users", () => {
		authRole = "user";
		renderShell();

		expect(screen.getByTestId("active-username")).toHaveTextContent("viewer");
		expect(
			screen.getByRole("button", { name: /sign out viewer/i })
		).toBeVisible();
		for (const nav of screen.getAllByRole("navigation", { name: /primary/i })) {
			expect(within(nav).queryByText("Settings")).toBeNull();
			expect(within(nav).queryByText("Advanced")).toBeNull();
		}
	});
});
