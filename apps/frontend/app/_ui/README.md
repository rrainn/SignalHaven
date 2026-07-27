# SignalHaven Design System (U2)

The shared UI vocabulary used across the SignalHaven web app. All components live
under `apps/frontend/app/_ui/` and are re-exported from `./index.ts`. The
`_ui` prefix keeps the folder out of Next.js's app-router file-based routing.

## Foundations

- **Theming.** Components consume the **U1** semantic tokens defined as CSS
  variables in `app/globals.css` (e.g. `--color-surface`, `--color-accent`)
  and exposed to Tailwind in `tailwind.config.ts`. Every visual style maps to
  a token, so light/dark/future palettes flip with a single class on
  `<html>`.
- **Variants & sizes.** Variants are declared with
  [`class-variance-authority`](https://cva.style/). Each component re-exports
  its `*Styles` recipe so callers (or new variants) can compose without
  duplication.
- **Headless primitives.** Interactive components are built on
  [Radix UI](https://www.radix-ui.com/) for accessibility (focus traps,
  Escape handling, ARIA wiring, keyboard navigation, roving tabindex, etc.).
- **Motion.** Subtle entrance/exit animations use `tailwindcss-animate` and
  are wrapped in the `motion-safe:` Tailwind variant so they are dropped
  automatically under `prefers-reduced-motion: reduce`. Inline `transition-*`
  utilities are paired with `motion-reduce:transition-none` to disable
  hover/focus tweens for the same users.

## Components

| Component    | File             | Notes                                   |
| ------------ | ---------------- | --------------------------------------- |
| `Button`     | `Button.tsx`     | 6 variants × 3 sizes, optional `block`. |
| `IconButton` | `IconButton.tsx` | Square button; `aria-label` required.   |
| `Input`      | `Input.tsx`      | 3 sizes, supports `aria-invalid`.       |
| `Select`     | `Select.tsx`     | Radix Select.                           |
| `Switch`     | `Switch.tsx`     | Radix Switch.                           |
| `Slider`     | `Slider.tsx`     | Radix Slider, single & range thumbs.    |
| `Tabs`       | `Tabs.tsx`       | Radix Tabs (auto ARIA + keyboard nav).  |
| `Modal`      | `Modal.tsx`      | Radix Dialog (centred).                 |
| `Drawer`     | `Drawer.tsx`     | Radix Dialog (side sheet).              |
| `Toast`      | `Toast.tsx`      | Radix Toast (`role=status`/`alert`).    |
| `Tooltip`    | `Tooltip.tsx`    | Radix Tooltip.                          |
| `Skeleton`   | `Skeleton.tsx`   | `animate-pulse` placeholder.            |
| `Spinner`    | `Spinner.tsx`    | `role=status`, SR-only label.           |
| `Card`       | `Card.tsx`       | Header/Title/Description/Content/Footer |
| `Badge`      | `Badge.tsx`      | 5 variants.                             |
| `EmptyState` | `EmptyState.tsx` | Icon + title + description + action.    |

## Icons

We standardise on **[lucide-react](https://lucide.dev/)**. **Always import
icons individually** so the bundler can tree-shake the (very large) icon
catalogue:

```tsx
// ✅ tree-shakeable
import { Play, Pause } from "lucide-react";

// ❌ pulls every icon into the bundle
import * as Icons from "lucide-react";
```

Icons are decorative inside icon-only buttons and should be marked
`aria-hidden="true"`; the button itself supplies the accessible name via
`aria-label`. Inside text content, omit `aria-hidden` and rely on the
surrounding label.

## Stories (Ladle)

Each component has a `*.stories.tsx` file consumed by
[Ladle](https://ladle.dev/). Ladle is a **dev-only** dependency — it ships
nothing into production and is not imported from app code.

```bash
# from apps/frontend
pnpm run ladle    # http://localhost:61000
```

The Ladle global decorator (`.ladle/components.tsx`) wires up
`<ThemeProvider>`, `<ToastProvider>`, and `<TooltipProvider>` and exposes a
light/dark control in the toolbar.

## Tests

Interaction tests for `Modal`, `Tabs`, and `Toast` (focus trap, Escape, ARIA)
live alongside the rest of the frontend's Vitest suite under
`apps/frontend/tests/`.
