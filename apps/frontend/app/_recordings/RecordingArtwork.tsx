"use client";

import Image from "next/image";
import { Film } from "lucide-react";
import { useState } from "react";

import { cn } from "../_ui/cn";

export interface RecordingArtworkProps {
	src: string | null | undefined;
	title: string;
	className?: string | undefined;
	sizes?: string | undefined;
	priority?: boolean | undefined;
}

/**
 * Render EPG artwork with stable dimensions and a polished fallback. External
 * provider URLs mirror the channel-logo policy used elsewhere in the app.
 */
export function RecordingArtwork(props: RecordingArtworkProps) {
	const [failedSource, setFailedSource] = useState<string | null>(null);
	const source = props.src && props.src !== failedSource ? props.src : null;
	const fallback = (
		<div
			data-testid="recording-artwork-fallback"
			aria-label={`${props.title || "Recording"} artwork unavailable`}
			className="flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-muted p-4 text-center text-muted"
		>
			<Film aria-hidden="true" className="h-8 w-8" />
			<span className="text-xs font-medium">Artwork unavailable</span>
		</div>
	);

	if (!source) {
		return (
			<div className={cn("overflow-hidden", props.className)}>{fallback}</div>
		);
	}

	const imageClassName = "h-full w-full object-cover";
	const isLocal = source.startsWith("/");
	const isHttps = source.startsWith("https://");
	const isHttp = source.startsWith("http://");
	if (!isLocal && !isHttps && !isHttp) {
		return (
			<div className={cn("overflow-hidden", props.className)}>{fallback}</div>
		);
	}
	const optimisable = isHttps || isLocal;
	return (
		<div className={cn("relative overflow-hidden", props.className)}>
			{optimisable ? (
				<Image
					src={source}
					alt=""
					fill
					sizes={props.sizes ?? "(max-width: 640px) 100vw, 33vw"}
					className={imageClassName}
					onError={() => setFailedSource(source)}
					{...(props.priority ? { priority: true } : {})}
				/>
			) : (
				<img
					src={source}
					alt=""
					width={640}
					height={360}
					loading={props.priority ? "eager" : "lazy"}
					decoding="async"
					className={imageClassName}
					onError={() => setFailedSource(source)}
				/>
			)}
		</div>
	);
}
