import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefetch = vi.fn();

vi.mock("next/navigation", () => ({
	useRouter: () => ({ prefetch })
}));

vi.mock("next/link", () => ({
	default: forwardRef<
		HTMLAnchorElement,
		AnchorHTMLAttributes<HTMLAnchorElement> & {
			href: string;
			prefetch?: boolean | "auto" | null;
			children?: ReactNode;
		}
	>(function MockLink({ href, prefetch: mode, ...props }, ref) {
		return (
			<a ref={ref} href={href} data-next-prefetch={String(mode)} {...props} />
		);
	})
}));

import { IntentPrefetchLink } from "../app/_layout/SmartLink";

describe("SmartLink intent prefetch", () => {
	beforeEach(() => {
		prefetch.mockReset();
	});

	it("avoids viewport prefetch and warms the route only after user intent", async () => {
		const user = userEvent.setup();
		render(<IntentPrefetchLink href="/settings">Settings</IntentPrefetchLink>);
		const link = screen.getByRole("link", { name: "Settings" });

		expect(link).toHaveAttribute("data-next-prefetch", "false");
		expect(prefetch).not.toHaveBeenCalled();

		await user.hover(link);
		expect(prefetch).toHaveBeenCalledOnce();
		expect(prefetch).toHaveBeenCalledWith("/settings");

		await user.tab();
		expect(prefetch).toHaveBeenCalledOnce();
	});
});
