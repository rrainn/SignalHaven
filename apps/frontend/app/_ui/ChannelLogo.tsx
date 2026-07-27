"use client";

import Image from "next/image";
import { useState } from "react";

export interface ChannelLogoProps {
	src: string | null | undefined;
	/** Rendered logo size in CSS pixels (square). */
	size: number;
	className?: string;
	/** Render this when no logo is available. */
	fallback: React.ReactNode;
	/**
	 * When true (e.g. above-the-fold logos in the visible portion of the
	 * channel list), tells the image optimizer to drop `loading="lazy"`.
	 */
	priority?: boolean;
}

/**
 * Channel logo renderer.
 *
 * Channel logos come from arbitrary external IPTV / EPG providers and we
 * cannot enumerate their hostnames at build time. We use `next/image`
 * (which gives us explicit `width`/`height` to prevent CLS, automatic
 * `loading="lazy"`, `decoding="async"`, and AVIF/WebP negotiation via
 * the Next.js image optimizer) for local and `https://` URLs. For `http://`
 * URLs (mixed-content blocked by the browser in most deployments, but useful
 * in some self-hosted setups), we use the browser's native image element.
 * Failed, empty, and unsupported sources render the supplied fallback instead
 * of broken media.
 */
export function ChannelLogo({
	src,
	size,
	className,
	fallback,
	priority
}: ChannelLogoProps) {
	const [failedSource, setFailedSource] = useState<string | null>(null);
	const normalizedSource = src?.trim() || null;
	const source =
		normalizedSource && normalizedSource !== failedSource
			? normalizedSource
			: null;

	if (!source) return <>{fallback}</>;

	const isLocal = source.startsWith("/") && !source.startsWith("//");
	const isHttps = source.startsWith("https://");
	const isHttp = source.startsWith("http://");
	if (!isLocal && !isHttps && !isHttp) return <>{fallback}</>;

	const optimisable = isLocal || isHttps;
	if (optimisable) {
		return (
			<Image
				src={source}
				alt=""
				width={size}
				height={size}
				sizes={`${size}px`}
				className={className}
				onError={() => setFailedSource(source)}
				{...(priority ? { priority: true } : {})}
			/>
		);
	}

	return (
		<img
			src={source}
			alt=""
			width={size}
			height={size}
			loading={priority ? "eager" : "lazy"}
			decoding="async"
			className={className}
			onError={() => setFailedSource(source)}
		/>
	);
}
