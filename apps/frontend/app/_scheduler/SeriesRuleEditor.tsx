"use client";

import type { ChannelListItem, SeriesRule } from "@signalhaven/shared";
import { useEffect, useState } from "react";

import { Button } from "../_ui/Button";
import { Input } from "../_ui/Input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "../_ui/Select";
import { Spinner } from "../_ui/Spinner";

import {
	draftFromSeriesRule,
	initialSeriesRuleDraft,
	validateSeriesRuleDraft,
	type SeriesRuleDraft,
	type SeriesRuleValidationErrors,
	type SeriesRuleValidationOk
} from "./state";

export interface SeriesRuleEditorProps {
	/** When set, the editor is in "edit existing rule" mode. */
	rule?: SeriesRule | null | undefined;
	/** Channel list for the channel-restriction dropdown. */
	channels: ChannelListItem[];
	onSubmit: (value: SeriesRuleValidationOk["value"]) => Promise<void> | void;
	onCancel: () => void;
	submitting?: boolean | undefined;
	/**
	 * Server-side error message; rendered inline above the action row so
	 * users see why the submit attempt failed.
	 */
	serverError?: string | null | undefined;
}

/**
 * Series-rule editor (rrainn/SignalHaven#U9-scheduler).
 *
 * Renders the create/edit form for a "season pass" rule. Validation uses the
 * shared `seriesRuleCreateSchema`, including the optional age-retention limit,
 * so callers receive a canonical value that is safe to POST.
 */
export function SeriesRuleEditor(props: SeriesRuleEditorProps) {
	const [draft, setDraft] = useState<SeriesRuleDraft>(() =>
		props.rule ? draftFromSeriesRule(props.rule) : initialSeriesRuleDraft
	);
	const [errors, setErrors] = useState<SeriesRuleValidationErrors>({});

	// Re-seed when a different rule is opened in the same editor
	// instance (e.g. switching from "edit A" to "edit B").
	useEffect(() => {
		setDraft(
			props.rule ? draftFromSeriesRule(props.rule) : initialSeriesRuleDraft
		);
		setErrors({});
	}, [props.rule]);

	const update = <K extends keyof SeriesRuleDraft>(
		key: K,
		value: SeriesRuleDraft[K]
	) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
	};

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const result = validateSeriesRuleDraft(draft);
		if (!result.ok) {
			setErrors(result.errors);
			return;
		}
		setErrors({});
		await props.onSubmit(result.value);
	};

	return (
		<form
			onSubmit={handleSubmit}
			aria-label={props.rule ? "Edit series rule" : "Create series rule"}
			className="space-y-3"
			data-testid="series-rule-editor"
			noValidate
		>
			<label className="block space-y-1 text-sm">
				<span className="text-primary">Title</span>
				<Input
					data-testid="series-rule-title"
					value={draft.title}
					onChange={(e) => update("title", e.target.value)}
					aria-invalid={errors.title ? "true" : undefined}
					aria-describedby={
						errors.title ? "series-rule-title-error" : undefined
					}
					placeholder="e.g. Sherlock"
				/>
				{errors.title ? (
					<span
						id="series-rule-title-error"
						role="alert"
						data-testid="series-rule-title-error"
						className="block text-xs text-danger"
					>
						{errors.title}
					</span>
				) : null}
			</label>

			<label className="block space-y-1 text-sm">
				<span className="text-primary">Channel (optional)</span>
				<Select
					value={draft.channelId ?? "any"}
					onValueChange={(v) => update("channelId", v === "any" ? null : v)}
				>
					<SelectTrigger data-testid="series-rule-channel">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="any">Any channel</SelectItem>
						{props.channels.map((c) => (
							<SelectItem key={c.id} value={c.id}>
								{c.number} {c.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</label>

			<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<label className="block space-y-1 text-sm">
					<span className="text-primary">Keep newest episodes</span>
					<Input
						data-testid="series-rule-keep-count"
						type="number"
						inputMode="numeric"
						min={1}
						max={1000}
						value={draft.keepCount}
						onChange={(e) => update("keepCount", e.target.value)}
						aria-invalid={errors.keepCount ? "true" : undefined}
						aria-describedby={
							errors.keepCount ? "series-rule-keep-count-error" : undefined
						}
					/>
					{errors.keepCount ? (
						<span
							id="series-rule-keep-count-error"
							role="alert"
							data-testid="series-rule-keep-count-error"
							className="block text-xs text-danger"
						>
							{errors.keepCount}
						</span>
					) : null}
				</label>

				<label className="block space-y-1 text-sm">
					<span className="text-primary">Age limit (days)</span>
					<Input
						data-testid="series-rule-retention-days"
						type="number"
						inputMode="numeric"
						min={1}
						max={36500}
						step={1}
						value={draft.retentionDays}
						onChange={(e) => update("retentionDays", e.target.value)}
						aria-invalid={errors.retentionDays ? "true" : undefined}
						aria-describedby={
							errors.retentionDays
								? "series-rule-retention-days-error"
								: "series-rule-retention-policy-help"
						}
						placeholder="No limit"
					/>
					{errors.retentionDays ? (
						<span
							id="series-rule-retention-days-error"
							role="alert"
							data-testid="series-rule-retention-days-error"
							className="block text-xs text-danger"
						>
							{errors.retentionDays}
						</span>
					) : null}
				</label>

				<label className="block space-y-1 text-sm">
					<span className="text-primary">Priority</span>
					<Input
						data-testid="series-rule-priority"
						type="number"
						inputMode="numeric"
						min={-100}
						max={100}
						value={draft.priority}
						onChange={(e) => update("priority", e.target.value)}
						aria-invalid={errors.priority ? "true" : undefined}
						aria-describedby={
							errors.priority ? "series-rule-priority-error" : undefined
						}
					/>
					{errors.priority ? (
						<span
							id="series-rule-priority-error"
							role="alert"
							data-testid="series-rule-priority-error"
							className="block text-xs text-danger"
						>
							{errors.priority}
						</span>
					) : null}
				</label>
			</div>

			<p
				id="series-rule-retention-policy-help"
				className="text-xs text-secondary"
			>
				Keep count always applies; blank means no age limit. When both limits
				are set, an unprotected recording is removed as soon as either limit
				requires it. Protected recordings are never auto-deleted.
			</p>

			<label className="block space-y-1 text-sm">
				<span className="text-primary">Episode policy</span>
				<Select
					value={draft.episodePolicy}
					onValueChange={(value) =>
						update("episodePolicy", value as SeriesRuleDraft["episodePolicy"])
					}
				>
					<SelectTrigger
						data-testid="series-rule-episode-policy"
						aria-label="Episode policy"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All episodes</SelectItem>
						<SelectItem value="confirmed_new">Confirmed new only</SelectItem>
						<SelectItem value="new_and_unknown">
							New and unclassified
						</SelectItem>
					</SelectContent>
				</Select>
				<span className="block text-xs text-secondary">
					Confirmed new uses guide-provider evidence. Choose unclassified when
					your provider omits new or rerun markers.
				</span>
			</label>

			{props.serverError ? (
				<p
					role="alert"
					data-testid="series-rule-server-error"
					className="text-sm text-danger"
				>
					{props.serverError}
				</p>
			) : null}

			<div className="flex justify-end gap-2 pt-1">
				<Button
					type="button"
					variant="ghost"
					onClick={props.onCancel}
					data-testid="series-rule-cancel"
				>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={props.submitting === true}
					data-testid="series-rule-submit"
				>
					{props.submitting === true ? (
						<Spinner aria-hidden="true" className="h-4 w-4" />
					) : null}
					{props.rule ? "Save changes" : "Create rule"}
				</Button>
			</div>
		</form>
	);
}
