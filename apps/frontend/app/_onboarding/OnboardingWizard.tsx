"use client";

import type { EpgSource, Settings, Tuner } from "@signalhaven/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	listEpgSources,
	refreshEpgSource,
	syncTunerChannels
} from "../../lib/api-client";
import { GUIDE_INVALIDATE_EVENT } from "../../lib/app-events";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalHeader,
	ModalTitle
} from "../_ui/Modal";
import { cn } from "../_ui/cn";
import {
	ONBOARDING_STEPS,
	ONBOARDING_STEP_LABELS,
	nextStep,
	prevStep,
	writePersistedState,
	type OnboardingStep
} from "./state";
import { DoneStep } from "./steps/DoneStep";
import { EpgStep } from "./steps/EpgStep";
import { MappingStep } from "./steps/MappingStep";
import { StorageStep } from "./steps/StorageStep";
import { TunersStep } from "./steps/TunersStep";
import { WelcomeStep } from "./steps/WelcomeStep";

export type OnboardingWizardProps = {
	open: boolean;
	initialStep?: OnboardingStep | undefined;
	initialTuners: Tuner[];
	initialEpgSources: EpgSource[];
	initialSettings: Settings;
	/** Called when the user dismisses or completes the wizard. */
	onClose: (reason: "completed" | "dismissed") => void;
};

/**
 * Modal-based first-run wizard. Steps are rendered one at a time; the
 * current step is persisted to localStorage so closing the app mid-flow
 * resumes where the user left off.
 */
export function OnboardingWizard(props: OnboardingWizardProps) {
	const {
		open,
		initialStep,
		initialTuners,
		initialEpgSources,
		initialSettings,
		onClose
	} = props;

	const [step, setStep] = useState<OnboardingStep>(initialStep ?? "welcome");
	const [tuners, setTuners] = useState<Tuner[]>(initialTuners);
	const [epgSources, setEpgSources] = useState<EpgSource[]>(initialEpgSources);
	const [storagePath, setStoragePath] = useState<string | null>(
		initialSettings.storage.path
	);
	const [guidePreparationComplete, setGuidePreparationComplete] =
		useState(false);
	const epgRefreshStartedRef = useRef(false);

	// Persist the current step on every change so the wizard is resumable.
	useEffect(() => {
		if (!open) return;
		writePersistedState({ step });
	}, [open, step]);

	useEffect(() => {
		if (!open || step !== "epg") {
			return;
		}
		// Tuner creation provisions HDHomeRun guides server-side, so refresh the
		// collection when this step opens instead of asking for duplicate input.
		void listEpgSources()
			.then((result) => setEpgSources(result.items))
			.catch(() => undefined);
	}, [open, step]);

	useEffect(() => {
		if (!open || step !== "done" || epgRefreshStartedRef.current) return;

		if (tuners.length === 0) {
			const enabledSources = epgSources.filter((source) => source.enabled);
			// Sources can finish loading after the user reaches Done, so leave the
			// effect armed until there is actual refresh work to start.
			if (enabledSources.length === 0) return;
			epgRefreshStartedRef.current = true;
			void Promise.allSettled(
				enabledSources.map((source) => refreshEpgSource(source.id))
			).then(() => setGuidePreparationComplete(true));
			return;
		}

		epgRefreshStartedRef.current = true;
		void (async () => {
			// Matching needs tuner channels to exist before a guide refresh imports
			// and auto-maps its listings, especially for already-configured tuners.
			await Promise.allSettled(
				tuners.map((tuner) => syncTunerChannels(tuner.id))
			);

			let sources = epgSources;
			try {
				const result = await listEpgSources();
				sources = result.items;
				setEpgSources(result.items);
			} catch {
				// The sources already loaded into the wizard remain a safe fallback.
			}

			// A failed source must not prevent other configured guides from importing.
			await Promise.allSettled(
				sources
					.filter((source) => source.enabled)
					.map((source) => refreshEpgSource(source.id))
			);
			setGuidePreparationComplete(true);
		})();
	}, [epgSources, open, step, tuners]);

	const hasGuidePreparationWork =
		tuners.length > 0 || epgSources.some((source) => source.enabled);
	const guideIsPreparing =
		step === "done" && hasGuidePreparationWork && !guidePreparationComplete;

	const goNext = useCallback(() => setStep((s) => nextStep(s)), []);
	const goBack = useCallback(() => setStep((s) => prevStep(s)), []);
	const skip = useCallback(() => setStep((s) => nextStep(s)), []);
	const finish = useCallback(() => {
		// The Guide is mounted behind onboarding and may have cached its initial
		// empty response before setup imported channels and schedule data.
		window.dispatchEvent(new Event(GUIDE_INVALIDATE_EVENT));
		onClose("completed");
	}, [onClose]);

	const currentIndex = ONBOARDING_STEPS.indexOf(step);
	const totalSteps = ONBOARDING_STEPS.length;

	const titles = useMemo(
		() => ({
			welcome: "Welcome to SignalHaven",
			tuners: "Detect tuners",
			epg: "Review guide data",
			storage: "Choose recordings folder",
			mapping: "Channel mapping",
			done: "You're all set"
		}),
		[]
	);

	const descriptions = useMemo(
		() => ({
			welcome: "Get SignalHaven ready in a few quick steps.",
			tuners:
				"Discover or manually add the tuners SignalHaven will stream from.",
			epg: "Review automatic guides or add an XMLTV source.",
			storage: "Pick the folder where SignalHaven writes recordings.",
			mapping: "Review how SignalHaven pairs tuner channels with guide data.",
			done: "SignalHaven is configured and ready to use."
		}),
		[]
	);

	return (
		<Modal
			open={open}
			onOpenChange={(value) => {
				if (!value) onClose("dismissed");
			}}
		>
			<ModalContent
				// The wizard is wider than the default modal so multi-column step
				// forms breathe. Cap height + scroll inside so long content (the
				// discovered-tuners list) doesn't overflow the viewport.
				className="max-w-2xl gap-0 p-0"
				// We render our own step header below; suppress the close button
				// so dismissal goes through the explicit "Skip setup" affordance
				// (or the Escape key, which Radix wires up by default).
				showCloseButton={false}
				data-testid="onboarding-wizard"
			>
				<ModalHeader className="border-b border-border p-6">
					<div className="flex items-center justify-between gap-4">
						<ModalTitle>{titles[step]}</ModalTitle>
						<span className="text-xs text-muted">
							Step {currentIndex + 1} of {totalSteps}
						</span>
					</div>
					<ModalDescription className="sr-only">
						{descriptions[step]}
					</ModalDescription>
					<ol
						aria-label="Onboarding progress"
						className="mt-3 flex items-center gap-1"
					>
						{ONBOARDING_STEPS.map((s, idx) => (
							<li
								key={s}
								aria-current={s === step ? "step" : undefined}
								className={cn(
									"h-1 flex-1 rounded-full transition-colors motion-safe:transition-all",
									idx < currentIndex
										? "bg-success"
										: idx === currentIndex
											? "bg-accent"
											: "bg-surface-muted"
								)}
							>
								<span className="sr-only">{ONBOARDING_STEP_LABELS[s]}</span>
							</li>
						))}
					</ol>
				</ModalHeader>

				<div
					className="max-h-[70vh] overflow-y-auto p-6"
					data-testid={`onboarding-step-${step}`}
				>
					{step === "welcome" ? (
						<WelcomeStep onNext={goNext} onSkip={() => onClose("dismissed")} />
					) : null}

					{step === "tuners" ? (
						<TunersStep
							existingTuners={tuners}
							onTunerCreated={(t) => setTuners((prev) => [...prev, t])}
							onNext={goNext}
							onBack={goBack}
							onSkip={skip}
						/>
					) : null}

					{step === "epg" ? (
						<EpgStep
							existingSources={epgSources}
							onSourceCreated={(s) => setEpgSources((prev) => [...prev, s])}
							onNext={goNext}
							onBack={goBack}
							onSkip={skip}
						/>
					) : null}

					{step === "storage" ? (
						<StorageStep
							currentPath={storagePath}
							onPathSaved={setStoragePath}
							onNext={goNext}
							onBack={goBack}
							onSkip={skip}
						/>
					) : null}

					{step === "mapping" ? (
						<MappingStep onNext={goNext} onBack={goBack} onSkip={skip} />
					) : null}

					{step === "done" ? (
						<DoneStep preparing={guideIsPreparing} onFinish={finish} />
					) : null}
				</div>
			</ModalContent>
		</Modal>
	);
}
