/**
 * Only Guide URLs can be restored from an untrusted return-path query
 * parameter. Keeping this helper server-safe lets route entry points validate
 * before passing the value into a client component.
 */
export function safeGuideReturnPath(value?: string): string {
	if (!value) return "/guide";
	try {
		const url = new URL(value, "https://signalhaven.invalid");
		if (
			url.origin !== "https://signalhaven.invalid" ||
			url.pathname !== "/guide"
		) {
			return "/guide";
		}
		return `${url.pathname}${url.search}`;
	} catch {
		return "/guide";
	}
}
