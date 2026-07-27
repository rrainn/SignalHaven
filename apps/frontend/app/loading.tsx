import { Spinner } from "./_ui/Spinner";

/** Consistent route transition feedback while a server segment is loading. */
export default function Loading() {
	return (
		<div
			className="flex min-h-64 items-center justify-center"
			role="status"
			aria-label="Loading page"
		>
			<Spinner />
		</div>
	);
}
