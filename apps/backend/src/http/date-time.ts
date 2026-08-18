/**
 * Serialize API timestamps without fractional seconds so generated native
 * clients can decode the same RFC 3339 value on every supported OS release.
 */
export function toApiDateTime(value: Date): string {
	return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
