import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Slider } from "../app/_ui/Slider";

describe("Slider", () => {
	it("gives its interactive thumb the supplied accessible name", () => {
		render(<Slider aria-label="Volume" defaultValue={[50]} max={100} />);

		expect(screen.getByRole("slider", { name: "Volume" })).toBeInTheDocument();
	});
});
