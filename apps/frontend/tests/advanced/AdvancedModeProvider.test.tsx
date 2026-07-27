import { act, renderHook } from "@testing-library/react";
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
});
