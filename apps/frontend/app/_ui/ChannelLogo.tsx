"use client";

import { useState } from "react";

export interface ChannelLogoProps {
	src: string | null | undefined;
	/** Rendered logo size in CSS pixels (square). */
	size: number;
	className?: string;
	/** Render this when no logo is available. */
	fallback: React.ReactNode;
	/**
	 * When true, eagerly load an above-the-fold logo.
	 */
	priority?: boolean;
}

/**
 * Channel logo renderer.
 *
 * Only backend API paths are accepted so the browser never contacts an IPTV
 * or EPG provider directly. Failed and unsupported sources use the fallback.
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

	const isBackendApi = source.startsWith("/api/") && !source.startsWith("//");
	if (!isBackendApi) return <>{fallback}</>;

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
