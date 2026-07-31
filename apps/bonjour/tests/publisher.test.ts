import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config";
import { createTxtRecord } from "../src/publisher";

test("publishes the canonical URL with the version 2 discovery contract", () => {
	const config = loadConfig({
		PUBLIC_URL: "https://service.example.com/base/"
	});

	assert.deepEqual(
		createTxtRecord(config, "f22b18a0-f7f1-40fd-9225-2da245803a47"),
		{
			txtvers: "2",
			protovers: "2",
			url: "https://service.example.com/base",
			id: "f22b18a0-f7f1-40fd-9225-2da245803a47"
		}
	);
});
