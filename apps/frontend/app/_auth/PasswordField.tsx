"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentPropsWithoutRef } from "react";

import { IconButton } from "../_ui/IconButton";
import { Input } from "../_ui/Input";

type PasswordFieldProps = Omit<
	ComponentPropsWithoutRef<typeof Input>,
	"type"
> & {
	label: string;
};

/** Keeps password visibility explicit without changing the underlying value. */
export function PasswordField({
	label,
	id,
	className,
	...props
}: PasswordFieldProps) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="space-y-1.5 text-sm">
			<label className="block font-medium text-primary" htmlFor={id}>
				{label}
			</label>
			<span className="relative block">
				<Input
					{...props}
					id={id}
					type={visible ? "text" : "password"}
					className={`h-12 pr-12 ${className ?? ""}`}
				/>
				<IconButton
					type="button"
					variant="ghost"
					size="sm"
					aria-label={
						visible
							? `Hide ${label.toLowerCase()}`
							: `Show ${label.toLowerCase()}`
					}
					aria-pressed={visible}
					onClick={() => setVisible((current) => !current)}
					className="absolute right-1.5 top-1/2 -translate-y-1/2"
				>
					{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
				</IconButton>
			</span>
		</div>
	);
}
