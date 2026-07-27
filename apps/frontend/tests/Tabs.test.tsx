import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../app/_ui/Tabs";

function renderTabs() {
	return render(
		<Tabs defaultValue="one">
			<TabsList aria-label="Sample tabs">
				<TabsTrigger value="one">One</TabsTrigger>
				<TabsTrigger value="two">Two</TabsTrigger>
				<TabsTrigger value="three">Three</TabsTrigger>
			</TabsList>
			<TabsContent value="one">Panel one</TabsContent>
			<TabsContent value="two">Panel two</TabsContent>
			<TabsContent value="three">Panel three</TabsContent>
		</Tabs>
	);
}

describe("Tabs", () => {
	it("renders an accessible tablist with tab/tabpanel ARIA roles", () => {
		renderTabs();
		expect(
			screen.getByRole("tablist", { name: /sample tabs/i })
		).toBeInTheDocument();
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(3);
		// Default selected tab is wired up to its panel.
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel one");
	});

	it("activates the next tab on ArrowRight (roving tabindex)", async () => {
		const user = userEvent.setup();
		renderTabs();

		const tabs = screen.getAllByRole("tab");
		const [first, second, third] = tabs;
		if (!first || !second || !third) throw new Error("expected 3 tabs");
		act(() => first.focus());

		await user.keyboard("{ArrowRight}");
		expect(second).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel two");

		await user.keyboard("{ArrowRight}");
		expect(third).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel three");
	});

	it("jumps to last/first tab via End/Home", async () => {
		const user = userEvent.setup();
		renderTabs();
		const tabs = screen.getAllByRole("tab");
		const [first, , third] = tabs;
		if (!first || !third) throw new Error("expected 3 tabs");
		act(() => first.focus());

		await user.keyboard("{End}");
		expect(third).toHaveAttribute("aria-selected", "true");

		await user.keyboard("{Home}");
		expect(first).toHaveAttribute("aria-selected", "true");
	});
});
