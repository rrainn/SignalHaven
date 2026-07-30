# Frontend performance baseline

This document captures the perf baseline for the SignalHaven frontend after the
[U12-perf](https://github.com/rrainn/SignalHaven/issues/40) pass. Re-run the
checklist below whenever a major feature lands (player, guide, recordings,
settings) or any time bundle size changes meaningfully on a PR.

## Bundle analysis

Run a one-off bundle analysis with:

```sh
pnpm --filter @signalhaven/frontend analyze
# Opens an interactive treemap on http://localhost:4000 (Turbopack
# analyzer; built into Next.js 16). Use Ctrl-C to stop the server.
```

The `analyze` script wraps `next build --experimental-analyze` so a
normal `next build` stays fast.

### Largest dependencies (gzipped)

| Dependency               |                   gz size | Justified?                                                                                           |
| ------------------------ | ------------------------: | ---------------------------------------------------------------------------------------------------- |
| `next` runtime + chunks  |                   ~134 KB | Yes — framework baseline.                                                                            |
| `react-dom`              |                    ~36 KB | Yes — required.                                                                                      |
| `hls.js`                 |                   ~150 KB | Yes — only loaded inside `useHls` after `<Player>` mounts; preferred over native HLS when supported. |
| `lucide-react` icons     | < 5 KB on any single page | Yes — per-icon imports tree-shake; we never bulk-import the index.                                   |
| `@radix-ui/*` primitives |       ~20 KB across pages | Yes — only the components actually used (Dialog/Select/Slider/Switch/Tabs/Toast/Tooltip).            |
| `framer-motion`          |                         — | **Removed in U12-perf.** Was a transitive carry-over from an earlier prototype with zero imports.    |

The single dependency over the 100 KB-gz threshold is `hls.js`. It is
explicitly justified because:

1. It is **dynamically imported** in `app/_player/useHls.ts` and only
   when a `<Player>` actually mounts.
2. It is preferred on Safari versions with Media Source support because its
   transmuxer accepts source streams that Safari's native decoder can reject.
   Native HLS remains the fallback on older Apple platforms.
3. It is therefore **not part of any non-watch route's critical path**
   — the guide, channels, scheduler, recordings library, and settings
   pages never request the chunk.

## Code-splitting verification

Per-route entries reported by `next build`:

```
Route (app)
┌ ○ /
├ ○ /channels
├ ○ /guide
├ ○ /recordings
├ ƒ /recordings/[id]
├ ƒ /recordings/series/[seriesRuleId]
├ ○ /scheduler
├ ○ /settings
└ ƒ /watch/[channelId]
```

- Each route file (`app/<route>/page.tsx`) is a thin wrapper around a
  client module under `app/_<feature>/`. Next.js auto-splits one chunk
  per route, so the recordings library, scheduler, and settings code
  ships only when a user actually navigates to those screens.
- `app/_player/useHls.ts` dynamically imports `hls.js` (~150 KB gz)
  inside an effect after the player mounts. The module stays out of every
  non-playback route while remaining the preferred playback engine.
- Storybook (`@ladle/react`) is in `devDependencies` only and serves
  out of `pnpm --filter @signalhaven/frontend ladle` — it is never bundled into production.
- "Admin"-only screens (the Tuners / EPG / Storage / Transcoding
  sections of `/settings`) live in `app/_settings/*Section.tsx` and
  are imported by `SettingsPage`, which is only loaded when the
  user navigates to `/settings`.

## Image optimization

- All channel logos are rendered via the new `ChannelLogo` component
  (`app/_ui/ChannelLogo.tsx`), which delegates to `next/image` for
  `https://` sources (the common case) with explicit `width`/`height`
  to prevent CLS.
- `next.config.ts` enables `formats: ['image/avif', 'image/webp']` so
  the optimizer negotiates AVIF (≈30–50 % smaller than WebP, ≈50–80 %
  smaller than JPEG) when supported, falling back to WebP, then to
  the original.
- `imageSizes` is constrained to small thumbnails (16–256 px) so we
  do not generate dozens of unused variants for the small (≤ 96 px)
  channel logos that dominate our usage.

## Route prefetching

`app/_layout/SmartLink.tsx` wraps `next/link` and disables eager
prefetch for routes flagged as "heavy" (`/watch`, `/recordings`) when:

- the user has Save-Data on (`navigator.connection.saveData === true`),
  **or**
- the network is reported as `slow-2g`, `2g`, or `3g`
  (`effectiveType`).

Light routes (guide, channels, scheduler, settings) still prefetch
because their chunks are small and the win on tap-latency is real.
The bottom navigation bar (mobile-only) and top app bar both use
`SmartLink`.

## Lighthouse budgets

`.lighthouserc.json` enforces the following minima on each of
`/guide`, `/watch/<channel>`, `/recordings`, and `/settings` when run
from CI. The job runs Lighthouse three times per URL and asserts
against the median run to keep CI noise below the budget headroom.

| Category       | Min score |
| -------------- | --------: |
| Performance    |        90 |
| Accessibility  |        95 |
| Best Practices |        95 |
| SEO            |        90 |

A single median run that drops below any of these fails the
`Lighthouse budgets` job in `.github/workflows/ci.yml`. The full
HTML + JSON reports for all 12 runs are uploaded as a
`lighthouse-report` workflow artifact for inspection.

### Mobile profile + CPU throttling note

We use Lighthouse's mobile form factor with the standard Slow-4G
network throttle (1.6 Mb/s down, 750 Kb/s up, 150 ms RTT) but with
**`cpuSlowdownMultiplier: 1`** instead of the desktop-default `4`.
This is the configuration Lighthouse-CI itself recommends for shared
runners ([docs](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md#chromium-flags)):
the `4×` multiplier is calibrated against a developer-class baseline
machine, but a GitHub Actions VM is itself an order of magnitude
slower than that baseline, so layering an extra `4×` on top
double-penalises CI and produces metrics that are far slower than any
real mobile device. With `1×` we still measure the mobile network
profile + viewport, which is what the U12-perf acceptance criteria
calls out, while keeping the assertion noise floor below the budget.

### Mock backend

Because the four screens above are client-rendered and call
`/api/v1/*` on first paint, running Lighthouse against the
production server with no backend would leave every page in a
spinner state — which crushes LCP and the perf score. The CI job
therefore boots a tiny zero-dep Node script
([`apps/frontend/scripts/lighthouse-mock-backend.mjs`](../apps/frontend/scripts/lighthouse-mock-backend.mjs))
that answers the GET endpoints with the smallest fixtures that
satisfy the shared Zod schemas, and points the frontend's
`SIGNALHAVEN_BACKEND_ORIGIN` rewrite at it. The mock is not used in
production.

### Baseline scores

Captured on the `ubuntu-latest` GitHub Actions runner with the
config above, median of three runs:

| Route         | Perf | A11y |   BP |
| ------------- | ---: | ---: | ---: |
| `/guide`      | 1.00 | 0.98 | 0.96 |
| `/recordings` | 0.93 | 1.00 | 0.96 |
| `/settings`   | 0.92 | 1.00 | 0.96 |
| `/watch/[id]` | 0.96 | 0.96 | 0.96 |

All comfortably above the budget thresholds.

## Playwright FCP assertion

`apps/frontend/e2e/perf.spec.ts` boots the production server, applies
a Slow-3G network profile (1.5 Mb/s down, 750 Kb/s up, 40 ms RTT) and
4× CPU throttle via the Chrome DevTools Protocol, then asserts the
First Contentful Paint of `/guide` under 1500 ms. The page request is
mocked at the API layer (the same fixtures used by `e2e/guide.spec.ts`)
so the measurement is dominated by frontend code, not backend latency.
