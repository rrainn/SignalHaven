import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecordingArtwork } from "../../app/_recordings/RecordingArtwork";

describe("RecordingArtwork", () => {
	it("renders a same-origin backend image", () => {
		const { container } = render(
			<RecordingArtwork
				src="/api/v1/recordings/recording-id/artwork"
				title="Example"
			/>
		);

		expect(container.querySelector("img")).toHaveAttribute(
			"src",
			"/api/v1/recordings/recording-id/artwork"
		);
	});

	it("refuses a raw provider image URL", () => {
		const { container } = render(
			<RecordingArtwork src="https://images.example/show.jpg" title="Example" />
		);

		expect(container.querySelector("img")).not.toBeInTheDocument();
		expect(
			screen.getByTestId("recording-artwork-fallback")
		).toBeInTheDocument();
	});
});
