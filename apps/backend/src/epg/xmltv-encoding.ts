/**
 * Encoding shim for XMLTV input streams.
 *
 * The SAX parser expects UTF-8. XMLTV producers in the wild routinely
 * declare other encodings (ISO-8859-1, windows-1252, ...) in their
 * `<?xml version="1.0" encoding="..."?>` prologue, so we sniff the
 * declaration from the first chunk and transcode to UTF-8 with
 * `iconv-lite` before the parser sees it. The XML declaration itself is
 * rewritten to advertise UTF-8 so the parser doesn't double-decode.
 *
 * Implementation note: this is a `Transform` rather than a manually
 * driven `PassThrough` so backpressure flows through `pipe()` correctly
 * — important for multi-MB inputs where consumers (e.g. the importer)
 * pause to flush COPY batches.
 */

import { Readable, Transform, type TransformCallback } from "node:stream";

import { decodeStream as iconvDecodeStream, encodingExists } from "iconv-lite";

const XML_DECL_REGEX =
	/^<\?xml\s+[^>]*\bencoding\s*=\s*["']([^"']+)["'][^>]*\?>/i;

/** Maximum bytes inspected while sniffing the XML declaration. */
const SNIFF_SIZE = 256;

function normalizeEncoding(label: string): string {
	return label.toLowerCase().replace(/[_\s]/g, "-");
}

function isUtf8Like(label: string): boolean {
	const normalized = normalizeEncoding(label);
	return normalized === "utf-8" || normalized === "utf8";
}

/**
 * Sniff-then-transcode transform. Buffers up to {@link SNIFF_SIZE}
 * bytes, decides whether to transcode, then either:
 *  - emits the buffered bytes verbatim and forwards subsequent chunks
 *    unchanged (UTF-8 case), or
 *  - rewrites the `<?xml ... encoding="..."?>` declaration to UTF-8 and
 *    pushes every byte through an iconv-lite decoder.
 */
class XmltvDecodeTransform extends Transform {
	private head: Buffer[] = [];
	private headBytes = 0;
	private decided = false;
	/** When transcoding, holds the iconv decoder we forward bytes through. */
	private decoder: NodeJS.ReadWriteStream | null = null;

	override _transform(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: TransformCallback
	): void {
		if (!this.decided) {
			this.head.push(chunk);
			this.headBytes += chunk.length;
			if (this.headBytes >= SNIFF_SIZE) {
				try {
					this.decide();
				} catch (err) {
					callback(err as Error);
					return;
				}
			} else {
				callback();
				return;
			}
			callback();
			return;
		}

		if (this.decoder) {
			// Backpressure: if iconv buffers up, pause until drained.
			const ok = this.decoder.write(chunk);
			if (!ok) {
				this.decoder.once("drain", callback);
			} else {
				callback();
			}
		} else {
			this.push(chunk);
			callback();
		}
	}

	override _flush(callback: TransformCallback): void {
		if (!this.decided) {
			try {
				this.decide();
			} catch (err) {
				callback(err as Error);
				return;
			}
		}
		if (this.decoder) {
			this.decoder.end();
			// The decoder's `end` event will trigger the final `push(null)`
			// via the data forwarding wired in `decide()`.
			this.decoder.once("end", () => callback());
			this.decoder.once("error", (err) => callback(err));
		} else {
			callback();
		}
	}

	private decide(): void {
		this.decided = true;
		const combined = Buffer.concat(this.head);
		this.head = [];
		const probe = combined.subarray(0, SNIFF_SIZE).toString("ascii");
		const match = XML_DECL_REGEX.exec(probe);
		const declared = match ? match[1] : null;

		if (declared && !isUtf8Like(declared) && encodingExists(declared)) {
			// Strip the original XML declaration; the rewritten header below
			// advertises UTF-8 so the parser stops at the first `?>` and never
			// sees the legacy label. We assume the declaration is wholly
			// contained in the sniff window (true for well-formed XMLTV).
			const ltIdx = combined.indexOf(0x3c);
			const gtIdx = combined.indexOf(0x3e, ltIdx);
			const declEnd = gtIdx >= 0 ? gtIdx + 1 : 0;
			const rest = combined.subarray(declEnd);

			const decoder = iconvDecodeStream(declared);
			decoder.on("data", (chunk: string | Buffer) => {
				const out =
					typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
				if (!this.push(out)) {
					decoder.pause();
				}
			});
			decoder.on("end", () => {
				this.push(null);
			});
			decoder.on("error", (err) => {
				this.destroy(err);
			});
			// Resume decoder when downstream drains.
			this.on("drain", () => decoder.resume());

			this.push(Buffer.from('<?xml version="1.0" encoding="UTF-8"?>'));
			if (rest.length > 0) {
				decoder.write(rest);
			}
			this.decoder = decoder;
		} else {
			// Already UTF-8 (or unknown but compatible enough). Forward verbatim.
			if (combined.length > 0) {
				this.push(combined);
			}
		}
	}
}

/**
 * Wrap a binary input stream so it emits UTF-8 bytes, sniffing any
 * `<?xml ... encoding="..."?>` declaration and transcoding when needed.
 * The returned stream is suitable to pipe directly into the SAX parser.
 */
export function decodeStream(
	input: NodeJS.ReadableStream
): NodeJS.ReadableStream {
	const transform = new XmltvDecodeTransform();
	input.on("error", (err) => transform.destroy(err as Error));
	input.pipe(transform);
	return transform;
}

/** Convenience helper for tests: decode an in-memory buffer. */
export function decodeBuffer(buffer: Buffer): NodeJS.ReadableStream {
	return decodeStream(Readable.from([buffer]));
}
