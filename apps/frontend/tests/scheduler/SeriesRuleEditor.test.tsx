import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SeriesRule } from "@signalhaven/shared";

import { SeriesRuleEditor } from "../../app/_scheduler/SeriesRuleEditor";

/**
 * Component test for the U9 series-rule editor — focuses on the
 * validation contract called out in the issue ("component tests for
 * rule editor validation"). Wiring of the editor inside the scheduler
 * page is exercised in `SchedulerPage.test.tsx`.
 */

describe("SeriesRuleEditor", () => {
	it("blocks submit and surfaces a title error when title is blank", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<SeriesRuleEditor
				channels={[]}
				onSubmit={onSubmit}
				onCancel={() => undefined}
			/>
		);

		await user.click(screen.getByTestId("series-rule-submit"));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByTestId("series-rule-title-error")).toBeInTheDocument();
	});

	it("rejects keepCount of 0 with an inline error", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<SeriesRuleEditor
				channels={[]}
				onSubmit={onSubmit}
				onCancel={() => undefined}
			/>
		);
		await user.type(screen.getByTestId("series-rule-title"), "Sherlock");
		const keep = screen.getByTestId("series-rule-keep-count");
		await user.clear(keep);
		await user.type(keep, "0");
		await user.click(screen.getByTestId("series-rule-submit"));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("series-rule-keep-count-error")
		).toBeInTheDocument();
	});

	it("rejects priority outside -100..100 with an inline error", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<SeriesRuleEditor
				channels={[]}
				onSubmit={onSubmit}
				onCancel={() => undefined}
			/>
		);
		await user.type(screen.getByTestId("series-rule-title"), "Sherlock");
		const prio = screen.getByTestId("series-rule-priority");
		await user.clear(prio);
		await user.type(prio, "500");
		await user.click(screen.getByTestId("series-rule-submit"));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("series-rule-priority-error")
		).toBeInTheDocument();
	});

	it("calls onSubmit with coerced values when the draft is valid", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		render(
			<SeriesRuleEditor
				channels={[]}
				onSubmit={onSubmit}
				onCancel={() => undefined}
			/>
		);
		await user.type(screen.getByTestId("series-rule-title"), "Sherlock");
		await user.click(screen.getByTestId("series-rule-submit"));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith({
			title: "Sherlock",
			channelId: null,
			keepCount: 5,
			retentionDays: null,
			newOnly: false,
			priority: 0
		});
	});

	it("seeds the form from an existing rule when editing", () => {
		const rule: SeriesRule = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Existing show",
			channelId: null,
			epgChannelId: null,
			keepCount: 7,
			newOnly: true,
			priority: -3,
			retentionDays: 30,
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z"
		};
		render(
			<SeriesRuleEditor
				rule={rule}
				channels={[]}
				onSubmit={vi.fn()}
				onCancel={() => undefined}
			/>
		);
		expect(screen.getByTestId("series-rule-title")).toHaveValue(
			"Existing show"
		);
		expect(screen.getByTestId("series-rule-keep-count")).toHaveValue(7);
		expect(screen.getByTestId("series-rule-retention-days")).toHaveValue(30);
		expect(screen.getByTestId("series-rule-priority")).toHaveValue(-3);
	});

	it("shows no age limit for a legacy rule without retention days", () => {
		const rule: SeriesRule = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Legacy show",
			channelId: null,
			epgChannelId: null,
			keepCount: 7,
			newOnly: false,
			priority: 0,
			retentionDays: null,
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z"
		};
		render(
			<SeriesRuleEditor
				rule={rule}
				channels={[]}
				onSubmit={vi.fn()}
				onCancel={() => undefined}
			/>
		);

		expect(screen.getByTestId("series-rule-retention-days")).toHaveValue(null);
		expect(screen.getByText(/blank means no age limit/i)).toBeInTheDocument();
	});

	it("rejects fractional retention days with an inline error", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<SeriesRuleEditor
				channels={[]}
				onSubmit={onSubmit}
				onCancel={() => undefined}
			/>
		);
		await user.type(screen.getByTestId("series-rule-title"), "Sherlock");
		await user.type(screen.getByTestId("series-rule-retention-days"), "1.5");
		await user.click(screen.getByTestId("series-rule-submit"));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("series-rule-retention-days-error")
		).toBeInTheDocument();
	});

	it("renders a server-side error when supplied", () => {
		render(
			<SeriesRuleEditor
				channels={[]}
				serverError="Server said no"
				onSubmit={vi.fn()}
				onCancel={() => undefined}
			/>
		);
		expect(screen.getByTestId("series-rule-server-error")).toHaveTextContent(
			"Server said no"
		);
	});
});
