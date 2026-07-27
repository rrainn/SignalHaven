import assert from "node:assert/strict";
import test from "node:test";
import { encode as iconvEncode } from "iconv-lite";

import { decodeBuffer } from "../src/epg/xmltv-encoding";
import {
	parseXmltvStream,
	parseXmltvTimestamp,
	resolveTimezoneOffsetMinutes,
	type XmltvChannel,
	type XmltvProgram
} from "../src/epg/xmltv-parser";

async function parse(xml: Buffer | string, timezone?: string) {
	const channels: XmltvChannel[] = [];
	const programs: XmltvProgram[] = [];
	const buf = typeof xml === "string" ? Buffer.from(xml, "utf8") : xml;
	await parseXmltvStream(
		decodeBuffer(buf),
		{
			onChannel: (c) => {
				channels.push(c);
			},
			onProgram: (p) => {
				programs.push(p);
			}
		},
		timezone ? { defaultTimezone: timezone } : {}
	);
	return { channels, programs };
}

test("parseXmltvTimestamp parses UTC offsets", () => {
	const date = parseXmltvTimestamp("20260101120000 +0000");
	assert.equal(date.toISOString(), "2026-01-01T12:00:00.000Z");

	const negative = parseXmltvTimestamp("20260101120000 -0500");
	assert.equal(negative.toISOString(), "2026-01-01T17:00:00.000Z");

	const positive = parseXmltvTimestamp("20260101120000 +0530");
	assert.equal(positive.toISOString(), "2026-01-01T06:30:00.000Z");
});

test("parseXmltvTimestamp uses default timezone when offset omitted", () => {
	const utc = parseXmltvTimestamp("20260101120000");
	assert.equal(utc.toISOString(), "2026-01-01T12:00:00.000Z");

	const eastern = parseXmltvTimestamp("20260101120000", "America/New_York");
	// Standard time in January: UTC-5.
	assert.equal(eastern.toISOString(), "2026-01-01T17:00:00.000Z");

	const fixed = parseXmltvTimestamp("20260101120000", "+02:00");
	assert.equal(fixed.toISOString(), "2026-01-01T10:00:00.000Z");
});

test("resolveTimezoneOffsetMinutes handles DST transitions", () => {
	// Spring forward in America/New_York: 2026-03-08 02:00 -> 03:00.
	// 1:30am wall-clock is still EST (UTC-5) -> -300 minutes.
	const beforeDst = resolveTimezoneOffsetMinutes(
		"America/New_York",
		2026,
		3,
		8,
		1,
		30,
		0
	);
	assert.equal(beforeDst, -300);

	// 4:00am wall-clock is EDT (UTC-4) -> -240 minutes.
	const afterDst = resolveTimezoneOffsetMinutes(
		"America/New_York",
		2026,
		3,
		8,
		4,
		0,
		0
	);
	assert.equal(afterDst, -240);
});

test("parseXmltvStream emits channels and programs", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <tv>
      <channel id="c1">
        <display-name>Channel One</display-name>
        <display-name>C1</display-name>
      </channel>
      <channel id="c2"><display-name>Channel Two</display-name></channel>
      <programme channel="c1" start="20260101120000 +0000" stop="20260101130000 +0000">
        <title>Hello</title>
        <sub-title>Pilot</sub-title>
        <desc>An episode</desc>
        <category>News</category>
        <category>Talk</category>
        <episode-num system="onscreen">S02E03</episode-num>
      </programme>
      <programme channel="c2" start="20260101140000 +0000" stop="20260101150000 +0000">
        <title>World</title>
        <episode-num system="xmltv_ns">1.4.0/1</episode-num>
      </programme>
    </tv>`;
	const { channels, programs } = await parse(xml);
	assert.equal(channels.length, 2);
	assert.equal(channels[0]?.displayName, "Channel One");
	assert.equal(channels[1]?.externalId, "c2");

	assert.equal(programs.length, 2);
	const first = programs[0]!;
	assert.equal(first.channelExternalId, "c1");
	assert.equal(first.title, "Hello");
	assert.equal(first.subtitle, "Pilot");
	assert.equal(first.description, "An episode");
	assert.deepEqual(first.categories, ["News", "Talk"]);
	assert.equal(first.season, 2);
	assert.equal(first.episode, 3);
	assert.equal(first.start.toISOString(), "2026-01-01T12:00:00.000Z");
	assert.equal(first.stop.toISOString(), "2026-01-01T13:00:00.000Z");
	assert.equal(first.externalId, "c1|2026-01-01T12:00:00.000Z");

	const second = programs[1]!;
	assert.equal(second.season, 2);
	assert.equal(second.episode, 5);
});

test("parseXmltvStream preserves every channel display name", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <tv>
      <channel id="US20370.hdhomerun.com">
        <display-name>KWGNDT</display-name>
        <display-name>2.1</display-name>
      </channel>
    </tv>`;

	const { channels } = await parse(xml);

	assert.deepEqual(channels[0]?.displayNames, ["KWGNDT", "2.1"]);
});

test("parseXmltvStream falls back to external id for missing display-name", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <tv>
      <channel id="silent" />
      <programme channel="silent" start="20260101120000 +0000" stop="20260101130000 +0000">
        <title>Quiet</title>
      </programme>
    </tv>`;
	const { channels } = await parse(xml);
	assert.equal(channels.length, 1);
	assert.equal(channels[0]?.externalId, "silent");
	assert.equal(channels[0]?.displayName, null);
});

test("parseXmltvStream handles programs spanning DST transitions", async () => {
	// Program straddling the spring-forward in America/New_York.
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <tv>
      <channel id="dst"><display-name>DST</display-name></channel>
      <programme channel="dst" start="20260308013000 -0500" stop="20260308040000 -0400">
        <title>DST Special</title>
      </programme>
    </tv>`;
	const { programs } = await parse(xml);
	assert.equal(programs.length, 1);
	const program = programs[0]!;
	assert.equal(program.start.toISOString(), "2026-03-08T06:30:00.000Z");
	assert.equal(program.stop.toISOString(), "2026-03-08T08:00:00.000Z");
	// Wall-clock duration is 1.5h (since DST skips an hour) — verify the
	// absolute moments match.
	assert.equal(
		program.stop.getTime() - program.start.getTime(),
		90 * 60 * 1000
	);
});

test("parseXmltvStream decodes ISO-8859-1 input", async () => {
	const xml =
		`<?xml version="1.0" encoding="ISO-8859-1"?>` +
		`<tv><channel id="c1"><display-name>Cl\u00e9ment</display-name></channel>` +
		`<programme channel="c1" start="20260101120000 +0000" stop="20260101130000 +0000">` +
		`<title>Caf\u00e9</title>` +
		`</programme></tv>`;
	const buffer = iconvEncode(xml, "iso-8859-1");
	const { channels, programs } = await parse(buffer);
	assert.equal(channels.length, 1);
	assert.equal(channels[0]?.displayName, "Cl\u00e9ment");
	assert.equal(programs[0]?.title, "Caf\u00e9");
});

test("parseXmltvStream skips programmes with malformed timestamps", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <tv>
      <channel id="c1"><display-name>One</display-name></channel>
      <programme channel="c1" start="not-a-time" stop="also-bad">
        <title>Skipped</title>
      </programme>
      <programme channel="c1" start="20260101120000 +0000" stop="20260101130000 +0000">
        <title>Kept</title>
      </programme>
    </tv>`;
	const { programs } = await parse(xml);
	assert.equal(programs.length, 1);
	assert.equal(programs[0]?.title, "Kept");
});
