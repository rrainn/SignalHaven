/** Preserves the final guide geometry while its code or data is loading. */
export function GuideLoadingSkeleton() {
	return (
		<div
			data-testid="guide-loading"
			aria-label="Loading guide"
			role="status"
			className="h-[28rem] overflow-hidden rounded-lg border border-border bg-surface"
		>
			<div className="h-11 animate-pulse border-b border-border bg-surface-muted motion-reduce:animate-none" />
			{Array.from({ length: 6 }, (_, index) => (
				<div
					key={index}
					className="flex h-16 border-b border-border last:border-b-0"
				>
					<div className="w-28 shrink-0 animate-pulse border-r border-border bg-surface-muted motion-reduce:animate-none sm:w-44" />
					<div className="flex flex-1 gap-1 p-1">
						<div className="w-1/3 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
						<div className="w-1/4 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
						<div className="flex-1 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
					</div>
				</div>
			))}
			<span className="sr-only">Loading guide</span>
		</div>
	);
}
