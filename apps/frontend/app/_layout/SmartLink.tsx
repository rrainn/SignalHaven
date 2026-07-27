"use client";

import Link, { type LinkProps } from "next/link";
import {
	forwardRef,
	useEffect,
	useState,
	type AnchorHTMLAttributes,
	type ReactNode
} from "react";

/**
 * Routes whose page chunks are heavy enough that we don't want to eagerly
 * prefetch them on hover when the user is on a metered / slow connection.
 *
 * Keep this list narrow — Next.js's default prefetch is a real win on the
 * happy path (FCP improvement on link click). We only opt _out_ for
 * routes whose JS payload is dominated by media-player code or large
 * tabular UIs (recordings library, watch screen).
 */
const HEAVY_ROUTES: ReadonlyArray<string> = ["/watch", "/recordings"];

function isHeavyRoute(href: string): boolean {
	return HEAVY_ROUTES.some(
		(prefix) => href === prefix || href.startsWith(`${prefix}/`)
	);
}

/**
 * Hook that returns `true` when the current network conditions suggest we
 * should suppress eager prefetching. Driven by the experimental
 * Network Information API (`navigator.connection`) — supported on
 * Chromium and Android browsers, where mobile users mostly live. On
 * unsupported browsers we conservatively return `false` (i.e. prefetch
 * normally) so we don't regress desktop performance.
 *
 * Triggers when **any** of:
 *   - `saveData` is on (user-explicit "Data Saver"),
 *   - `effectiveType` is `"slow-2g"`, `"2g"`, or `"3g"`.
 *
 * The value is read once on mount and re-read on the connection's
 * `change` event so toggling Data Saver in the OS takes effect without
 * a full reload.
 */
export function useSaveData(): boolean {
	const [saveData, setSaveData] = useState(false);

	useEffect(() => {
		if (typeof navigator === "undefined") return;
		const conn = (
			navigator as Navigator & {
				connection?: {
					saveData?: boolean;
					effectiveType?: string;
					addEventListener?: (type: "change", cb: () => void) => void;
					removeEventListener?: (type: "change", cb: () => void) => void;
				};
			}
		).connection;
		if (!conn) return;

		const read = () => {
			const slow =
				conn.effectiveType === "slow-2g" ||
				conn.effectiveType === "2g" ||
				conn.effectiveType === "3g";
			setSaveData(Boolean(conn.saveData) || slow);
		};
		read();
		conn.addEventListener?.("change", read);
		return () => conn.removeEventListener?.("change", read);
	}, []);

	return saveData;
}

export type SmartLinkProps = Omit<LinkProps, "href"> &
	Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | "href"> & {
		href: string;
		children?: ReactNode;
	};

/**
 * Drop-in `next/link` replacement that disables eager prefetch for
 * heavy routes when the user is on a Save-Data or slow connection.
 *
 * - On a fast/unmetered connection: behaves identically to `<Link>`.
 * - On Save-Data / 2G / 3G: passes `prefetch={false}` for any href that
 *   matches {@link HEAVY_ROUTES}. Light routes still prefetch — the
 *   shell HTML is small and the next-route JS is needed almost
 *   immediately on tap.
 *
 * An explicit `prefetch={false}` on the call site always wins, so call
 * sites can opt out unconditionally.
 */
export const SmartLink = forwardRef<HTMLAnchorElement, SmartLinkProps>(
	function SmartLink({ href, prefetch, ...rest }, ref) {
		const saveData = useSaveData();
		const computed: boolean | "auto" | null =
			prefetch === false
				? false
				: saveData && isHeavyRoute(href)
					? false
					: (prefetch ?? null);
		return <Link ref={ref} href={href} prefetch={computed} {...rest} />;
	}
);
