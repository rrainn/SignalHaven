import {
	act,
	render,
	renderHook,
	screen,
	waitFor
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
	ADVANCED_MODE_STORAGE_KEY,
	AdvancedModeProvider,
	useAdvancedMode
} from "../../app/_advanced/AdvancedModeProvider";

/** Supplies the app-owned preference boundary to the hook under test. */
function Wrapper({ children }: { children: ReactNode }) {
	return <AdvancedModeProvider>{children}</AdvancedModeProvider>;
}

/** Exposes the permission-adjusted value without inspecting provider internals. */
function Probe() {
	const advancedMode = useAdvancedMode();
	return (
		<div>
			<span data-testid="advanced-enabled">{String(advancedMode.enabled)}</span>
			<button type="button" onClick={() => advancedMode.setEnabled(true)}>
				Enable
			</button>
		</div>
	);
}

describe("AdvancedModeProvider", () => {
	it("persists the toggle in local storage", () => {
		const { result } = renderHook(() => useAdvancedMode(), {
			wrapper: Wrapper
		});

		act(() => result.current.setEnabled(true));

		expect(result.current.enabled).toBe(true);
		expect(localStorage.getItem(ADVANCED_MODE_STORAGE_KEY)).toBe("true");
	});

	it("restores a previously enabled mode", async () => {
		localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		const { result } = renderHook(() => useAdvancedMode(), {
			wrapper: Wrapper
		});

		await act(async () => undefined);

		expect(result.current.enabled).toBe(true);
	});

	it("revokes an administrator's browser flag after switching to a standard user", async () => {
		localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		const { rerender } = render(
			<AdvancedModeProvider isAdministrator>
				<Probe />
			</AdvancedModeProvider>
		);
		await waitFor(() =>
			expect(screen.getByTestId("advanced-enabled")).toHaveTextContent("true")
		);

		rerender(
			<AdvancedModeProvider isAdministrator={false}>
				<Probe />
			</AdvancedModeProvider>
		);

		await waitFor(() =>
			expect(screen.getByTestId("advanced-enabled")).toHaveTextContent("false")
		);
		expect(localStorage.getItem(ADVANCED_MODE_STORAGE_KEY)).toBe("false");
		act(() => screen.getByRole("button", { name: "Enable" }).click());
		expect(screen.getByTestId("advanced-enabled")).toHaveTextContent("false");
	});
});
