import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names safely.
 *
 * Combines `clsx` (arrays, objects, conditional classes) with
 * `tailwind-merge` (de-duplicates conflicting utilities — e.g. when a caller
 * passes `className="px-4"` to a component that already applies `px-2`, only
 * the caller's class survives).
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
