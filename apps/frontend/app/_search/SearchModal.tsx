"use client";

import type {
	SearchChannelHit,
	SearchProgramHit,
	SearchRecordingHit
} from "@signalhaven/shared";
import { Search, Tv, CalendarDays, Film } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent
} from "react";

import { Input } from "../_ui/Input";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalTitle
} from "../_ui/Modal";
import { Spinner } from "../_ui/Spinner";
import { cn } from "../_ui/cn";
import { use24HourClock } from "../_preferences/PreferencesProvider";
import { formatUpcomingDateTimePreference } from "../_preferences/formatting";

import {
	useGlobalSearch,
	type UseGlobalSearchOptions
} from "./useGlobalSearch";

/**
 * Cmd/Ctrl-K global search modal (rrainn/SignalHaven#U10-search).
 *
 * The modal is uncontrolled at the visual layer (Radix Dialog) so the
 * `Escape` key, outside-click, and focus-trap behaviours come from the
 * underlying primitive. This component layers on:
 *
 *   * A debounced + cancellable search hook (see `useGlobalSearch`).
 *   * Keyboard navigation across the flattened result list — Arrow Up
 *     / Down move the selection between groups, Enter activates, Tab
 *     stays inside Radix's focus trap.
 *   * Click navigation: channel → /watch/[id], program → /guide,
 *     recording → /recordings/[id].
 *
 * The component takes a `searchFn` override prop so tests can drive it
 * with a stub fetch and assert on debounce / cancellation behaviour
 * without a real network.
 */

export interface SearchModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Test seam — defaults to the live `searchAll` API client. */
	searchOptions?: UseGlobalSearchOptions;
}

type FlatHit =
	| { kind: "channel"; hit: SearchChannelHit; href: string }
	| { kind: "program"; hit: SearchProgramHit; href: string }
	| { kind: "recording"; hit: SearchRecordingHit; href: string };

export function SearchModal({
	open,
	onOpenChange,
	searchOptions
}: SearchModalProps) {
	const router = useRouter();
	const use24Hour = use24HourClock();
	const { query, setQuery, data, loading, error, reset } =
		useGlobalSearch(searchOptions);
	const inputId = useId();
	const listboxId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const hasQuery = query.trim().length > 0;

	const flat = useMemo<FlatHit[]>(() => {
		return [
			...data.channels.map((hit) => ({
				kind: "channel" as const,
				hit,
				href: `/watch/${encodeURIComponent(hit.id)}`
			})),
			...data.programs.map((hit) => ({
				kind: "program" as const,
				hit,
				href: buildProgramDetailsHref(hit)
			})),
			...data.recordings.map((hit) => ({
				kind: "recording" as const,
				hit,
				href: `/recordings/${encodeURIComponent(hit.id)}`
			}))
		];
	}, [data]);

	const [selected, setSelected] = useState(0);
	// Keep the dialog compact until there is meaningful result content to show.
	const showResults =
		error !== null || flat.length > 0 || (hasQuery && !loading);
	// Reset selection whenever the result set changes shape so the
	// highlight never points past the end.
	useEffect(() => {
		setSelected((prev) => (prev >= flat.length ? 0 : prev));
	}, [flat]);

	// When the modal closes, reset its internal state so re-opening is a
	// clean sheet.
	useEffect(() => {
		if (!open) reset();
	}, [open, reset]);

	// Auto-focus the input on open. Radix moves focus to the first
	// focusable element by default, but we explicitly target the input
	// so the user starts typing immediately.
	useEffect(() => {
		if (!open) return;
		const id = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(id);
	}, [open]);

	const navigate = useCallback(
		(href: string) => {
			router.push(href);
			onOpenChange(false);
		},
		[router, onOpenChange]
	);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			if (flat.length === 0) return;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSelected((prev) => (prev + 1) % flat.length);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setSelected((prev) => (prev - 1 + flat.length) % flat.length);
			} else if (event.key === "Enter") {
				event.preventDefault();
				const hit = flat[selected];
				if (hit) navigate(hit.href);
			}
		},
		[flat, selected, navigate]
	);

	return (
		<Modal open={open} onOpenChange={onOpenChange}>
			<ModalContent
				showCloseButton={false}
				className="top-[15%] max-w-xl translate-y-0 gap-3 p-0"
			>
				<ModalTitle className="sr-only">Search SignalHaven</ModalTitle>
				<ModalDescription className="sr-only">
					Search across channels, upcoming programs, and recordings.
				</ModalDescription>

				<div className="flex items-center gap-3 border-b border-border px-4 py-3">
					<Search aria-hidden="true" className="h-4 w-4 text-muted" />
					<label htmlFor={inputId} className="sr-only">
						Search query
					</label>
					<Input
						id={inputId}
						ref={inputRef}
						type="search"
						placeholder="Search channels, programs, recordings…"
						autoComplete="off"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={onKeyDown}
						aria-controls={showResults ? listboxId : undefined}
						aria-activedescendant={
							flat[selected] ? optionId(listboxId, selected) : undefined
						}
						className="h-10 border-0 bg-transparent px-0 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
					/>
					{loading ? <Spinner size="sm" /> : null}
				</div>

				<div
					role="listbox"
					id={listboxId}
					aria-label="Search results"
					hidden={!showResults}
					className="max-h-[60vh] overflow-y-auto px-2 pb-3"
					data-testid="search-results"
				>
					{error ? (
						<p
							role="alert"
							className="px-3 py-3 text-sm text-danger"
							data-testid="search-error"
						>
							{error}
						</p>
					) : null}

					{!loading && !error && hasQuery && flat.length === 0 ? (
						<p className="px-3 py-6 text-center text-sm text-muted">
							No matches for “{query.trim()}”.
						</p>
					) : null}

					{flat.length > 0 ? (
						<Group
							label="Channels"
							icon={Tv}
							hits={flat.filter((h) => h.kind === "channel")}
							flat={flat}
							listboxId={listboxId}
							selected={selected}
							onHover={setSelected}
							onSelect={navigate}
							renderItem={(item) => (
								<ChannelRow
									hit={(item as Extract<FlatHit, { kind: "channel" }>).hit}
								/>
							)}
						/>
					) : null}

					{flat.length > 0 ? (
						<Group
							label="Upcoming Programs"
							icon={CalendarDays}
							hits={flat.filter((h) => h.kind === "program")}
							flat={flat}
							listboxId={listboxId}
							selected={selected}
							onHover={setSelected}
							onSelect={navigate}
							renderItem={(item) => (
								<ProgramRow
									hit={(item as Extract<FlatHit, { kind: "program" }>).hit}
									use24Hour={use24Hour}
								/>
							)}
						/>
					) : null}

					{flat.length > 0 ? (
						<Group
							label="Recordings"
							icon={Film}
							hits={flat.filter((h) => h.kind === "recording")}
							flat={flat}
							listboxId={listboxId}
							selected={selected}
							onHover={setSelected}
							onSelect={navigate}
							renderItem={(item) => (
								<RecordingRow
									hit={(item as Extract<FlatHit, { kind: "recording" }>).hit}
								/>
							)}
						/>
					) : null}
				</div>
			</ModalContent>
		</Modal>
	);
}

/**
 * Keeps a useful Guide destination for the Back action while opening the
 * selected future program as its own deliberate details flow.
 */
function buildProgramDetailsHref(hit: SearchProgramHit): string {
	const guideQuery = new URLSearchParams({ at: hit.start });
	if (hit.channelId) guideQuery.set("channel", hit.channelId);
	const returnTo = `/guide?${guideQuery.toString()}`;
	return `/programs/${encodeURIComponent(hit.id)}?returnTo=${encodeURIComponent(returnTo)}`;
}

function optionId(listboxId: string, index: number): string {
	return `${listboxId}-opt-${index}`;
}

function Group({
	label,
	icon: Icon,
	hits,
	flat,
	listboxId,
	selected,
	onHover,
	onSelect,
	renderItem
}: {
	label: string;
	icon: typeof Tv;
	hits: FlatHit[];
	flat: FlatHit[];
	listboxId: string;
	selected: number;
	onHover: (index: number) => void;
	onSelect: (href: string) => void;
	renderItem: (item: FlatHit) => React.ReactNode;
}) {
	if (hits.length === 0) return null;
	return (
		<div className="py-2">
			<h3 className="flex items-center gap-2 px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted">
				<Icon aria-hidden="true" className="h-3.5 w-3.5" />
				{label}
			</h3>
			<ul className="flex flex-col">
				{hits.map((item) => {
					const index = flat.indexOf(item);
					const isSelected = index === selected;
					return (
						<li key={`${item.kind}-${item.hit.id}`}>
							<Link
								href={item.href}
								role="option"
								id={optionId(listboxId, index)}
								aria-selected={isSelected}
								data-selected={isSelected ? "true" : undefined}
								tabIndex={-1}
								onMouseEnter={() => onHover(index)}
								onClick={(event) => {
									// Let modifier-clicks (cmd/ctrl-click → new tab) work
									// normally; only intercept plain clicks so we can
									// close the modal on navigate.
									if (
										event.metaKey ||
										event.ctrlKey ||
										event.shiftKey ||
										event.altKey
									) {
										return;
									}
									event.preventDefault();
									onSelect(item.href);
								}}
								className={cn(
									"flex flex-col gap-0.5 rounded px-3 py-2 text-sm text-primary",
									"hover:bg-surface-muted",
									isSelected && "bg-surface-muted"
								)}
							>
								{renderItem(item)}
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function ChannelRow({ hit }: { hit: SearchChannelHit }) {
	return (
		<>
			<span className="font-medium">
				<span className="mr-2 text-muted">{hit.number}</span>
				{hit.name}
			</span>
			<span className="text-xs text-secondary">Live channel</span>
		</>
	);
}

function ProgramRow({
	hit,
	use24Hour
}: {
	hit: SearchProgramHit;
	use24Hour: boolean;
}) {
	const start = formatUpcomingDateTimePreference(hit.start, use24Hour);
	return (
		<>
			<span className="font-medium">{hit.title}</span>
			<span className="text-xs text-secondary">
				{hit.channelName ? (
					<>
						{hit.channelNumber ? `${hit.channelNumber} ` : ""}
						{hit.channelName} · {start}
					</>
				) : (
					start
				)}
			</span>
		</>
	);
}

function RecordingRow({ hit }: { hit: SearchRecordingHit }) {
	return (
		<>
			<span className="font-medium">{hit.title}</span>
			<span className="text-xs text-secondary">
				{hit.channelName ?? "Recording"} · {hit.status}
			</span>
		</>
	);
}
