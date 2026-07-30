import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChannelLogo } from "../app/_ui/ChannelLogo";

/** Render a logo with a stable fallback so tests stay focused on recovery. */
function renderLogo(src: string | null) {
	return render(
		<ChannelLogo
			src={src}
			size={32}
			fallback={<span>Channel logo unavailable</span>}
		/>
	);
}

describe("ChannelLogo", () => {
	it("replaces a failed backend image with the fallback", () => {
		const { container } = renderLogo("/api/v1/channels/channel-id/logo");
		const image = container.querySelector("img");
		expect(image).not.toBeNull();

		fireEvent.error(image!);

		expect(screen.getByText("Channel logo unavailable")).toBeInTheDocument();
		expect(container.querySelector("img")).not.toBeInTheDocument();
	});

	it.each([
		"",
		"   ",
		"javascript:alert(1)",
		"https://example.com/logo.png",
		"http://example.com/logo.png"
	])("uses the fallback for an unusable source", (src) => {
		const { container } = renderLogo(src);

		expect(screen.getByText("Channel logo unavailable")).toBeInTheDocument();
		expect(container.querySelector("img")).not.toBeInTheDocument();
	});

	it("tries a new source after the previous source fails", () => {
		const { container, rerender } = renderLogo("/api/v1/channels/old/logo");
		const image = container.querySelector("img");
		expect(image).not.toBeNull();
		fireEvent.error(image!);
		expect(screen.getByText("Channel logo unavailable")).toBeInTheDocument();

		rerender(
			<ChannelLogo
				src="/api/v1/channels/new/logo"
				size={32}
				fallback={<span>Channel logo unavailable</span>}
			/>
		);

		expect(container.querySelector("img")).toHaveAttribute(
			"src",
			"/api/v1/channels/new/logo"
		);
	});
});
