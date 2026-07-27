import type { Story } from "@ladle/react";
import {
	Bell,
	CircleHelp,
	Inbox,
	Pause,
	Play,
	Plus,
	Settings
} from "lucide-react";
import { useState } from "react";

import { Badge } from "./Badge";
import { Button } from "./Button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle
} from "./Card";
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerTitle,
	DrawerTrigger
} from "./Drawer";
import { EmptyState } from "./EmptyState";
import { IconButton } from "./IconButton";
import { Input } from "./Input";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalFooter,
	ModalHeader,
	ModalTitle,
	ModalTrigger
} from "./Modal";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "./Select";
import { Skeleton } from "./Skeleton";
import { Slider } from "./Slider";
import { Spinner } from "./Spinner";
import { Switch } from "./Switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";
import {
	Toast,
	ToastDescription,
	ToastProvider,
	ToastTitle,
	ToastViewport
} from "./Toast";
import { Tooltip } from "./Tooltip";

// ─── Button ───────────────────────────────────────────────────────────────

export const ButtonPrimary: Story = () => <Button>Save changes</Button>;
ButtonPrimary.storyName = "Primary";
ButtonPrimary.meta = { component: "Button" };

export const ButtonAllVariants: Story = () => (
	<div className="flex flex-wrap items-center gap-3">
		<Button variant="primary">Primary</Button>
		<Button variant="secondary">Secondary</Button>
		<Button variant="outline">Outline</Button>
		<Button variant="ghost">Ghost</Button>
		<Button variant="danger">Danger</Button>
		<Button variant="link">Link</Button>
	</div>
);
ButtonAllVariants.storyName = "All variants";
ButtonAllVariants.meta = { component: "Button" };

export const ButtonSizes: Story = () => (
	<div className="flex items-center gap-3">
		<Button size="sm">Small</Button>
		<Button size="md">Medium</Button>
		<Button size="lg">Large</Button>
	</div>
);
ButtonSizes.meta = { component: "Button" };

export const ButtonWithIcon: Story = () => (
	<Button>
		<Play aria-hidden="true" className="h-4 w-4" /> Play
	</Button>
);
ButtonWithIcon.meta = { component: "Button" };

// ─── IconButton ───────────────────────────────────────────────────────────

export const IconButtonAll: Story = () => (
	<div className="flex items-center gap-3">
		<IconButton aria-label="Play">
			<Play />
		</IconButton>
		<IconButton aria-label="Pause" variant="primary">
			<Pause />
		</IconButton>
		<IconButton aria-label="Settings" variant="outline">
			<Settings />
		</IconButton>
		<IconButton aria-label="Add" variant="secondary" size="lg">
			<Plus />
		</IconButton>
	</div>
);
IconButtonAll.storyName = "Variants & sizes";
IconButtonAll.meta = { component: "IconButton" };

// ─── Input ────────────────────────────────────────────────────────────────

export const InputDefault: Story = () => (
	<div className="flex max-w-sm flex-col gap-2">
		<label htmlFor="email" className="text-sm text-secondary">
			Email
		</label>
		<Input id="email" type="email" placeholder="you@example.com" />
	</div>
);
InputDefault.meta = { component: "Input" };

export const InputInvalid: Story = () => (
	<Input aria-invalid placeholder="invalid value" defaultValue="bad" />
);
InputInvalid.meta = { component: "Input" };

// ─── Select ───────────────────────────────────────────────────────────────

export const SelectStory: Story = () => (
	<Select>
		<SelectTrigger className="w-48">
			<SelectValue placeholder="Pick a quality" />
		</SelectTrigger>
		<SelectContent>
			<SelectItem value="auto">Auto</SelectItem>
			<SelectItem value="1080p">1080p</SelectItem>
			<SelectItem value="720p">720p</SelectItem>
			<SelectItem value="480p">480p</SelectItem>
		</SelectContent>
	</Select>
);
SelectStory.meta = { component: "Select" };

// ─── Switch ───────────────────────────────────────────────────────────────

export const SwitchStory: Story = () => {
	const [on, setOn] = useState(false);
	return (
		<label className="flex items-center gap-3 text-sm">
			<Switch
				checked={on}
				onCheckedChange={setOn}
				aria-label="Closed captions"
			/>
			Closed captions {on ? "on" : "off"}
		</label>
	);
};
SwitchStory.meta = { component: "Switch" };

// ─── Slider ───────────────────────────────────────────────────────────────

export const SliderStory: Story = () => (
	<div className="w-72">
		<Slider defaultValue={[40]} max={100} step={1} aria-label="Volume" />
	</div>
);
SliderStory.meta = { component: "Slider" };

export const SliderRange: Story = () => (
	<div className="w-72">
		<Slider defaultValue={[20, 80]} max={100} step={1} aria-label="Range" />
	</div>
);
SliderRange.meta = { component: "Slider" };

// ─── Tabs ─────────────────────────────────────────────────────────────────

export const TabsStory: Story = () => (
	<Tabs defaultValue="overview" className="w-96">
		<TabsList>
			<TabsTrigger value="overview">Overview</TabsTrigger>
			<TabsTrigger value="schedule">Schedule</TabsTrigger>
			<TabsTrigger value="extras">Extras</TabsTrigger>
		</TabsList>
		<TabsContent value="overview">Overview content.</TabsContent>
		<TabsContent value="schedule">Schedule content.</TabsContent>
		<TabsContent value="extras">Extras content.</TabsContent>
	</Tabs>
);
TabsStory.meta = { component: "Tabs" };

// ─── Modal ────────────────────────────────────────────────────────────────

export const ModalStory: Story = () => (
	<Modal>
		<ModalTrigger asChild>
			<Button>Open modal</Button>
		</ModalTrigger>
		<ModalContent>
			<ModalHeader>
				<ModalTitle>Delete recording?</ModalTitle>
				<ModalDescription>
					This action cannot be undone. The recording and its metadata will be
					removed.
				</ModalDescription>
			</ModalHeader>
			<ModalFooter>
				<Button variant="outline">Cancel</Button>
				<Button variant="danger">Delete</Button>
			</ModalFooter>
		</ModalContent>
	</Modal>
);
ModalStory.meta = { component: "Modal" };

// ─── Drawer ───────────────────────────────────────────────────────────────

export const DrawerStory: Story = () => (
	<Drawer>
		<DrawerTrigger asChild>
			<Button>Open drawer</Button>
		</DrawerTrigger>
		<DrawerContent side="right">
			<DrawerTitle>Filters</DrawerTitle>
			<DrawerDescription>
				Tweak the channel guide filters here.
			</DrawerDescription>
		</DrawerContent>
	</Drawer>
);
DrawerStory.storyName = "Right";
DrawerStory.meta = { component: "Drawer" };

// ─── Toast ────────────────────────────────────────────────────────────────

export const ToastStory: Story = () => {
	const [open, setOpen] = useState(false);
	return (
		<ToastProvider>
			<Button onClick={() => setOpen(true)}>Show toast</Button>
			<Toast open={open} onOpenChange={setOpen}>
				<div className="flex flex-col gap-1">
					<ToastTitle>Recording saved</ToastTitle>
					<ToastDescription>Available in your library.</ToastDescription>
				</div>
			</Toast>
			<ToastViewport />
		</ToastProvider>
	);
};
ToastStory.meta = { component: "Toast" };

// ─── Tooltip ──────────────────────────────────────────────────────────────

export const TooltipStory: Story = () => (
	<Tooltip content="Get help">
		<IconButton aria-label="Help">
			<CircleHelp />
		</IconButton>
	</Tooltip>
);
TooltipStory.meta = { component: "Tooltip" };

// ─── Skeleton ─────────────────────────────────────────────────────────────

export const SkeletonStory: Story = () => (
	<div className="flex flex-col gap-2">
		<Skeleton className="h-6 w-48" />
		<Skeleton className="h-4 w-64" />
		<Skeleton className="h-4 w-40" />
	</div>
);
SkeletonStory.meta = { component: "Skeleton" };

// ─── Spinner ──────────────────────────────────────────────────────────────

export const SpinnerStory: Story = () => (
	<div className="flex items-center gap-4">
		<Spinner size="sm" />
		<Spinner />
		<Spinner size="lg" label="Loading channels" />
	</div>
);
SpinnerStory.storyName = "Sizes";
SpinnerStory.meta = { component: "Spinner" };

// ─── Card ─────────────────────────────────────────────────────────────────

export const CardStory: Story = () => (
	<Card className="w-80">
		<CardHeader>
			<CardTitle>Channel 4.1 — KQED</CardTitle>
			<CardDescription>HD · Public broadcasting</CardDescription>
		</CardHeader>
		<CardContent className="text-sm text-secondary">
			Currently airing: <em>Frontline</em>.
		</CardContent>
		<CardFooter className="gap-2">
			<Button size="sm">
				<Play aria-hidden="true" className="h-4 w-4" /> Watch
			</Button>
			<Button size="sm" variant="outline">
				Record
			</Button>
		</CardFooter>
	</Card>
);
CardStory.meta = { component: "Card" };

// ─── Badge ────────────────────────────────────────────────────────────────

export const BadgeStory: Story = () => (
	<div className="flex flex-wrap gap-2">
		<Badge>Default</Badge>
		<Badge variant="accent">Accent</Badge>
		<Badge variant="success">Live</Badge>
		<Badge variant="danger">Recording</Badge>
		<Badge variant="outline">
			<Bell aria-hidden="true" className="h-3 w-3" />
			Reminder
		</Badge>
	</div>
);
BadgeStory.storyName = "Variants";
BadgeStory.meta = { component: "Badge" };

// ─── EmptyState ───────────────────────────────────────────────────────────

export const EmptyStateStory: Story = () => (
	<EmptyState
		icon={<Inbox />}
		title="No recordings yet"
		description="Schedule a recording from the guide to fill up your library."
		action={<Button>Browse guide</Button>}
	/>
);
EmptyStateStory.meta = { component: "EmptyState" };
