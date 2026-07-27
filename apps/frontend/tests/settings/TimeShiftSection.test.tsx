import { settingsDefaults } from "@signalhaven/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TimeShiftSection } from "../../app/_settings/TimeShiftSection";
import { updateSettings } from "../../lib/api-client";

vi.mock("../../lib/api-client", () => ({
	updateSettings: vi.fn()
}));

const updateSettingsMock = vi.mocked(updateSettings);

describe("TimeShiftSection", () => {
	beforeEach(() => {
		updateSettingsMock.mockReset();
	});

	it("saves a validated rolling-buffer policy", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		updateSettingsMock.mockResolvedValue({
			...settingsDefaults,
			timeShift: {
				...settingsDefaults.timeShift,
				durationMinutes: 30
			}
		});
		render(
			<TimeShiftSection settings={settingsDefaults} onChanged={onChanged} />
		);

		const duration = screen.getByLabelText("Window (minutes)");
		await user.clear(duration);
		await user.type(duration, "30");
		await user.click(
			screen.getByRole("button", { name: /save live tv buffer/i })
		);

		expect(updateSettingsMock).toHaveBeenCalledWith({
			timeShift: {
				...settingsDefaults.timeShift,
				durationMinutes: 30
			}
		});
		expect(onChanged).toHaveBeenCalled();
		expect(screen.getByRole("status")).toHaveTextContent(/new live sessions/i);
	});

	it("keeps the disabled fallback configurable without deleting values", async () => {
		const user = userEvent.setup();
		render(
			<TimeShiftSection settings={settingsDefaults} onChanged={vi.fn()} />
		);

		await user.click(screen.getByLabelText("Enable live TV buffer"));

		expect(screen.getByLabelText("Window (minutes)")).toBeDisabled();
		expect(screen.getByLabelText("Maximum disk (GB)")).toBeDisabled();
	});
});
