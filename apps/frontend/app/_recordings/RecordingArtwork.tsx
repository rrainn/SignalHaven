"use client";

import { Film } from "lucide-react";
import { useState } from "react";

import { cn } from "../_ui/cn";

export interface RecordingArtworkProps {
	src: string | null | undefined;
	title: string;
	className?: string | undefined;
	priority?: boolean | undefined;
}

/**
 * Render backend-proxied EPG artwork with stable dimensions and a fallback.
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
	const isBackendApi = source.startsWith("/api/") && !source.startsWith("//");
	if (!isBackendApi) {
		return (
			<div className={cn("overflow-hidden", props.className)}>{fallback}</div>
		);
	}
	return (
		<div className={cn("relative overflow-hidden", props.className)}>
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
		</div>
	);
}
