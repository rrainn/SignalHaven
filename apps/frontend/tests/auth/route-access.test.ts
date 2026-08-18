import { describe, expect, it } from "vitest";

import {
	isAdministratorPath,
	safeAppReturnPath
} from "../../app/_auth/route-access";

describe("auth route access", () => {
	it("accepts local application paths and rejects external or access routes", () => {
		expect(safeAppReturnPath("/recordings?view=list", "admin")).toBe(
			"/recordings?view=list"
		);
		expect(safeAppReturnPath("https://example.com", "admin")).toBe("/guide");
		expect(safeAppReturnPath("//example.com", "admin")).toBe("/guide");
		expect(safeAppReturnPath("/sign-in", "admin")).toBe("/guide");
		expect(safeAppReturnPath("/setup/account", "admin")).toBe("/guide");
	});

	it("prevents standard users from returning to administrator routes", () => {
		expect(safeAppReturnPath("/settings?tab=users", "user")).toBe("/guide");
		expect(safeAppReturnPath("/advanced", "user")).toBe("/guide");
		expect(safeAppReturnPath("/channels", "user")).toBe("/channels");
	});

	it("recognizes nested administrator routes", () => {
		expect(isAdministratorPath("/settings")).toBe(true);
		expect(isAdministratorPath("/settings/users")).toBe(true);
		expect(isAdministratorPath("/advanced")).toBe(true);
		expect(isAdministratorPath("/guide")).toBe(false);
	});
});
