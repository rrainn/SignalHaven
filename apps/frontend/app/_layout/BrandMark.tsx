import type { SVGProps } from "react";

type BrandMarkProps = SVGProps<SVGSVGElement> & {
	/** Adds a stable selector for rendered brand checks. */
	"data-testid"?: string;
};

/**
 * SignalHaven's compact symbol combines broadcast arcs with a protective
 * haven and negative-space play cue. Keeping the mark as SVG preserves its
 * silhouette from the app header down to favicon scale.
 */
export function BrandMark({ className, ...props }: BrandMarkProps) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			data-testid="brand-mark"
			focusable="false"
			viewBox="0 0 64 64"
			{...props}
		>
			{/* Separate signal bands keep the mark recognizable without relying on text. */}
			<path
				d="M10 22C20.5 9.5 43.5 9.5 54 22"
				fill="none"
				stroke="#2f6bff"
				strokeLinecap="round"
				strokeWidth="6"
			/>
			<path
				d="M18 29C25.4 20.6 38.6 20.6 46 29"
				fill="none"
				stroke="#42d8ff"
				strokeLinecap="round"
				strokeWidth="6"
			/>
			{/* The play triangle is cut out so the core remains crisp in one color. */}
			<path
				d="M8 30 18 36v4c0 6.4 4.8 11.5 14 16 9.2-4.5 14-9.6 14-16v-4l10-6c-.6 15.6-8.6 25.4-24 32C16.6 55.4 8.6 45.6 8 30Zm20 6v14l12-7-12-7Z"
				fill="currentColor"
				fillRule="evenodd"
			/>
		</svg>
	);
}
