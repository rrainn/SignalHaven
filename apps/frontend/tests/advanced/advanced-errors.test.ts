import { afterEach, describe, expect, it, vi } from "vitest";

import { ADVANCED_MODE_STORAGE_KEY } from "../../app/_advanced/AdvancedModeProvider";
import { getHealth } from "../../lib/api-client";

afterEach(() => vi.unstubAllGlobals());

describe("advanced client errors", () => {
	it("adds the server code and request id when advanced mode is enabled", async () => {
		localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: {
								code: "tuner_unavailable",
								message: "No tuner is currently available",
								requestId: "request-123"
							}
						}),
						{ status: 409, statusText: "Conflict" }
					)
			)
		);

		await expect(getHealth()).rejects.toThrow(
			/No tuner is currently available.*tuner_unavailable.*request-123.*HTTP 409/
		);
	});
});
