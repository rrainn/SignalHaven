---
name: SignalHaven
description: A calm, precise private broadcast deck for self-hosters.
colors:
  haven-navy: "#0B0E16"
  mineral-blue: "#2F6BFF"
  signal-cyan: "#42D8FF"
  background: "rgb(var(--color-background))"
  surface: "rgb(var(--color-surface))"
  surface-muted: "rgb(var(--color-surface-muted))"
  text-primary: "rgb(var(--color-text-primary))"
  text-secondary: "rgb(var(--color-text-secondary))"
  text-muted: "rgb(var(--color-text-muted))"
  control-blue: "rgb(var(--color-accent))"
  control-on-blue: "rgb(var(--color-accent-foreground))"
  live-signal: "rgb(var(--color-live))"
  live-on-signal: "rgb(var(--color-live-foreground))"
  cool-border: "rgb(var(--color-border))"
  danger: "rgb(var(--color-danger))"
  success: "rgb(var(--color-success))"
typography:
  headline:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  title:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    letterSpacing: "-0.025em"
  body:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.5rem"
    letterSpacing: "normal"
  label:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "normal"
rounded:
  sm: "0.125rem"
  md: "0.375rem"
  lg: "0.5rem"
  full: "9999px"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.control-blue}"
    textColor: "{colors.control-on-blue}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.5rem"
  button-secondary:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.5rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.5rem"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2.5rem"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "1rem"
  badge:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.5rem"
---

# Design System: SignalHaven

## Overview

**Creative North Star: "The Private Broadcast Deck"**

SignalHaven is advanced media infrastructure presented as a private broadcast deck: calm, precise, approachable, and dependable. It should feel ready and capable without looking aggressive, ornamental, or needlessly technical. Video is the product's most critical path and the reason the interface exists; whenever media is present, the interface recedes so playback becomes the unmistakable center of gravity.

The system earns polish through refined, restrained components, responsive layouts, legible density, exact state communication, and complete edge-state handling. Familiar system typography, slate surfaces, and purposeful color keep a technically sophisticated homelab product approachable during everyday use.

The brand mark combines signal, haven, and playback: two broadcast arcs sit over a protective lower form with a negative-space play symbol. Production SVGs are authoritative; the concept board at `docs/brand/signalhaven-logo-concept.png` is reference material only.

**Key Characteristics:**

- Calm, precise, approachable, and dependable.
- Content-first composition with compact application chrome.
- Video-first hierarchy that protects playback prominence, continuity, and control.
- Dense when the task rewards scanning; relaxed when the user is configuring or learning.
- Light and dark themes with identical hierarchy and meaning.
- Fast, functional motion and explicit reduced-motion support.

## Colors

The palette pairs a quiet slate foundation with a single functional blue voice and a narrowly reserved cyan live-state signal. Runtime semantic colors are CSS custom properties, allowing light and dark themes to change luminance without changing meaning.

### Primary

- **Control Blue** (`control-blue`): primary actions, links, selection, and keyboard focus. It is the application interaction color, distinct from the logo artwork's fixed blue.
- **Mineral Blue** (`mineral-blue`): the outer broadcast arc in approved brand artwork. Do not substitute it casually for the semantic application accent.

### Secondary

- **Signal Cyan** (`signal-cyan`): the fixed inner arc in approved brand artwork.
- **Live Signal / Live-on-Signal** (`live-signal`, `live-on-signal`): theme-aware cyan and its paired foreground for live, healthy, in-progress, and timeline indicators. Pair meaningful cyan states with text or an icon.

### Neutral

- **Haven Navy** (`haven-navy`): app-icon foundation and approved dark brand fields.
- **Daylight Canvas / Night Canvas** (`background`): the application field behind all task content.
- **Quiet Surface / Raised Navy** (`surface`): primary grouped surfaces, controls, and overlays.
- **Slate Wash / Deep Slate** (`surface-muted`): quiet selection, hover, secondary controls, and subtle grouping.
- **Graphite / Frost** (`text-primary`): primary copy and the responsive mark core.
- **Secondary Graphite / Silver Slate** (`text-secondary`): supporting copy that remains comfortably readable.
- **Muted Slate / Muted Steel** (`text-muted`): placeholders and low-emphasis metadata; never essential information without another cue.
- **Cool Border** (`cool-border`): precise structure, separators, and control outlines.
- **Control-on-Blue** (`control-on-blue`): content placed over the active semantic accent.

### Semantic

- **Danger** (`danger`): destructive actions, failed states, and adjacent recovery guidance.
- **Success** (`success`): completed or healthy states when a durable confirmation is useful.

**The One Control Voice Rule.** Control Blue owns actions, links, selection, and focus. The Signal Cyan family must not become a competing action color.

**The Meaning Survives Theme Rule.** Theme changes may alter luminance and contrast, never layout, hierarchy, semantics, or information density.

**The Contrast Before Identity Rule.** Identity accents never override accessible text and control tokens. Use the theme-aware Live-on-Signal foreground for content on live-state fills; fixed artwork cyan is not a text color.

## Typography

**Display Font:** None; SignalHaven does not use a separate display face.

**Body Font:** Native system sans-serif with platform emoji fallbacks.

**Character:** Typography behaves like a dependable instrument panel: immediately familiar, quick to render, and compact enough for schedules and media metadata. Hierarchy comes from size, weight, spacing, and placement rather than decorative type.

### Hierarchy

- **Headline** (semibold, `headline`): top-level page titles at 24 px with restrained tight tracking.
- **Title** (semibold, `title`): cards, groups, modal headings, and significant object names at 16 px; modal titles may step to 18 px.
- **Body** (regular, `body`): descriptions, form guidance, program metadata, and most interface copy at 14 px with a comfortable 24 px explanatory line height.
- **Label** (medium, `label`): badges, compact navigation, dense metadata, and terse control labels at 12 px.
- **Wordmark** (semibold, 16 px, `-0.025em`): selectable HTML text adjacent to the brand symbol; never text baked into an image.

**The Native Speed Rule.** Use the system stack throughout the application. Do not add a webfont merely to create personality; any future type change must justify its loading, rendering, and legibility cost.

**The Dense, Not Cramped Rule.** Reduce chrome before compressing content. Labels must remain readable, and explanatory text keeps a relaxed line height even in compact density.

## Layout

SignalHaven uses a content-first application shell capped at 72 rem (`max-w-6xl`) with 16 px horizontal gutters. The shell owns the single `main` landmark and its page padding; routed views begin directly inside it instead of adding another dashboard canvas.

Desktop uses a compact 56 px sticky top bar containing the lockup, primary navigation, search, and theme control. It must not become a utility dashboard or persistent sidebar. Mobile retains the compact top brand bar and moves primary navigation to a fixed bottom rail with safe-area padding for thumb reach.

Standard pages begin with one shared page header: title and description on the left, page-level actions aligned to the right when space allows and stacked below on narrow screens. Default vertical rhythm is 16 px between related regions and 24 px between independent groups. Cards use 16 px padding on narrow screens and 24 px from the small breakpoint upward; compact density reduces shared chrome to 12 px without shrinking touch-critical guide controls below 44 px.

Dense media surfaces are allowed to use the available viewport. Guide grids and peer-tab rails may scroll horizontally inside a clearly bounded region, while the page itself must never overflow horizontally. Stable rows, aligned time boundaries, sticky context, and deliberately hidden or thin scrollbars support scanning without creating nested-scroll traps.

Responsive thresholds follow the implemented Tailwind scale: 640 px (`sm`), 768 px (`md`), and 1024 px (`lg`) are the actively used composition changes. Narrow screens are recomposed, not scaled-down desktop layouts: stack forms and actions, disclose secondary filters, preserve readable labels, and reserve bottom space for fixed navigation.

**The Content Owns the Viewport Rule.** Interface chrome must never be the largest, brightest, or most detailed region in the first viewport.

**The Playback Is the Product Rule.** When video is present, it receives the strongest hierarchy and the most useful space. Navigation, metadata, and management controls must support playback without competing with it.

**The Bounded Overflow Rule.** Only an explicit component such as the guide grid or tab rail may scroll horizontally; page-level horizontal overflow is a defect.

## Elevation & Depth

Depth is restrained and structural. Background contrast and one-pixel cool borders establish most grouping. Resting content surfaces use only a minimal shadow; stronger shadows are reserved for elements that genuinely float above the current task, including menus, tooltips, toasts, drawers, players, and modal dialogs.

- **Surface Rest:** a subtle one-pixel ambient shadow supports bordered cards without making them appear detached.
- **Control Lift:** selected tabs, switches, and focused timeline items may use a compact local shadow.
- **Floating Utility:** tooltips use moderate elevation; selects and toasts use a stronger overlay shadow.
- **Modal Plane:** dialogs, drawers, and major player overlays use the strongest elevation in the system over a black 60% scrim.

Backdrop blur is limited to sticky navigation where it preserves context over scrolling content. It is not permission to introduce glass styling. Gradients, glows, bevels, ornamental 3D depth, and theme-specific effects are prohibited.

**The Flat-by-Default Rule.** A surface remains flat unless it represents a distinct object or moves onto a higher interaction plane.

**The One Boundary Rule.** Do not stack bordered cards inside bordered cards unless the inner boundary represents a genuinely independent object.

## Shapes

SignalHaven uses gently curved geometry with four explicit levels. Compact selected segments use a 2 px radius (`sm`); inputs, buttons, tabs, and compact controls use 6 px (`md`); grouped content, media frames, and overlays use 8 px (`lg`); badges, status dots, progress tracks, and other intrinsically pill-shaped elements use the full radius.

Borders are thin, cool, and precise. Dashed borders are reserved for intentional empty or drop-like states. The official mark is the one exception to the interface's rectilinear structure: its rounded signal arcs and protective silhouette remain unchanged.

The mark requires clear space of at least one quarter of its width. Use 16 px as the favicon minimum, 24 px for compact application UI, 28–32 px in standard headers, and at least 48 px for standalone digital placement. Never stretch, squash, rotate, crop, redraw, or optically recenter individual pieces.

**The Radius Has Meaning Rule.** Use full pills only for true badges, dots, tracks, or circular controls—not as a generic way to soften every container.

## Components

Components are precise, accessible, and state-complete. Every interactive control requires a visible label or accessible name, keyboard focus, disabled behavior, and a 44 px target on touch layouts. Brief color transitions are allowed; all animation honors both `prefers-reduced-motion` and the application's explicit animations-off preference.

### Brand Mark and Lockup

- Use `apps/frontend/app/_layout/BrandMark.tsx` as the responsive application mark and the SVG files in `apps/frontend/public/icons/` as editable icon sources.
- The official mark uses a Mineral Blue outer arc, Signal Cyan inner arc, and a solid haven with a negative-space play symbol.
- The standard application lockup uses a 32 px mark, an 8 px gap, and real semibold wordmark text.
- The favicon and app icon never contain the full product name.
- A logo link is named `SignalHaven home`; decorative marks beside text remain hidden from assistive technology.

### Buttons

- **Shape:** gently curved 6 px corners with medium-weight type.
- **Primary:** Control Blue with Control-on-Blue content; use for the clearest next action, not every available action.
- **Secondary:** Slate Wash, primary text, and a Cool Border for materially useful alternatives.
- **Ghost / Outline:** transparent at rest with a Slate Wash hover; use where surrounding structure already supplies containment.
- **Danger:** semantic Danger with white content for genuinely destructive actions.
- **Sizing:** 32, 40, and 48 px heights with proportional type and horizontal padding. Compact density reduces medium and large desktop chrome, but touch compositions preserve adequate targets.
- **States:** color transitions are brief; focus uses a 2 px Control Blue ring with 2 px offset; disabled controls stop receiving pointer input and reduce opacity.

### Cards and Containers

- Use a Quiet Surface, one Cool Border, 8 px corners, and minimal resting elevation.
- Internal padding is 16 px on narrow screens and 24 px at 640 px and above.
- A card groups one coherent object or task. Do not create a separate card for every field or nest decorative surfaces.
- Empty states may use a 50% surface tint and dashed border, centered around a reason and next useful action.

### Inputs, Selects, and Fields

- Inputs and select triggers use a Quiet Surface, Cool Border, 6 px corners, and 40 px default height.
- Labels remain visible; placeholders provide examples rather than replacing labels.
- Focus matches buttons. Invalid fields switch both border and focus ring to Danger and place recovery guidance next to the affected control.
- Select menus float one small offset from their trigger, use restrained overlay elevation, and highlight options with Slate Wash rather than a second accent.

### Tabs and Segmented Controls

- Tabs represent peer sections, never actions. The rail is a single Slate Wash boundary with 6 px corners and 4 px padding.
- Active triggers use a Quiet Surface, primary text, 2 px inner corners, and a compact shadow.
- Keep peers in one row. On narrow screens the rail scrolls horizontally instead of wrapping.
- Segmented controls visually merge adjacent options inside one shared boundary; only the active segment gains surface treatment.

### Navigation

- Desktop navigation is text-led and quiet. The selected destination uses Slate Wash and medium primary text; hover uses the same surface without competing with page content.
- Mobile navigation uses meaningful 16 px icons with short labels and assigns Control Blue only to the selected destination.
- Detail and playback routes keep their owning top-level destination selected so navigation state remains stable through the workflow.

### Dense Media Views

- Video playback is the critical path. Optimize its startup, continuity, recovery, and control clarity before adding secondary interface detail.
- Schedules use stable row heights, aligned time boundaries, and sticky context where useful.
- Live and recording states may use a thin Live Signal marker or progress track, always accompanied by a label such as `Live` or `Recording`.
- Artwork aids recognition but never replaces title and episode metadata. Missing artwork receives a deliberate neutral fallback.
- Playback controls sit on or immediately beside the media surface; supporting metadata and management actions follow below in priority order.

### Dialogs, Drawers, Tooltips, and Toasts

- Dialogs use a focused 8 px surface over a black 60% overlay, with explicit title, description, close affordance, focus containment, Escape handling, and focus restoration.
- Dialog actions stack in reverse order on narrow screens and align to the end from 640 px upward.
- Tooltips are compact 12 px utilities with moderate elevation and a short delay; they supplement accessible labels rather than replacing them.
- Toasts communicate actionable transient outcomes. Persistent or field-specific failures remain adjacent to their source.

### Loading, Empty, Error, and Motion States

- Every data view defines loading, empty, filtered-empty, partial-data, error, and retry behavior.
- Skeletons preserve known structure; spinners suit short bounded waits; loading copy names the object being prepared.
- Preserve stale data when refresh fails and add a compact recovery message instead of replacing useful content.
- Empty states explain why the area is empty and identify the best next action. Filtered-empty states provide a clear-filter path.
- Motion is functional, typically a brief color transition, fade, or 95% scale entrance. Never use animation as the only state signal.

## Do's and Don'ts

### Do:

- **Do** let the active task, media, and data own the viewport.
- **Do** give video the strongest hierarchy and protect playback startup, continuity, recovery, and controls as the application's highest-priority experience.
- **Do** preserve identical hierarchy, density, and semantics across light and dark themes.
- **Do** use Control Blue for interaction, reserve the theme-aware Live Signal token for live or healthy application states, and keep fixed Signal Cyan in brand artwork.
- **Do** keep interfaces responsive on realistic homelab hardware and treat loading, recovery, accessibility, and responsive behavior as part of the finished experience.
- **Do** use the committed production mark without redrawing it and test new placements at 16 px as well as their intended size.
- **Do** update this guide, production SVGs, generated raster assets, application metadata, and relevant tests together when approved identity geometry or palette changes.

### Don't:

- **Don't** introduce gradients, glows, glass effects, bevels, decorative 3D depth, or detailed imagery behind the mark.
- **Don't** add a persistent desktop sidebar, decorative dashboard shell, status widgets, or storage meters that compete with the current task.
- **Don't** use color alone for state, use fixed artwork cyan as interface text, or allow a second general-purpose action color.
- **Don't** use a separate card for every field, stack boundaries without meaning, or turn every compact shape into a pill.
- **Don't** compress labels, controls, or explanations merely to keep a desktop row intact on narrow screens.
- **Don't** put text inside the favicon or app icon, outline the play cutout, split the haven into competing colors, or replace the mark with a generic broadcast, house, antenna, lighthouse, TV frame, or shield.
- **Don't** change the mark's arc thickness, spacing, corner treatment, play geometry, or component alignment without updating every approved asset and testing favicon, header, and 512 px icon sizes.
