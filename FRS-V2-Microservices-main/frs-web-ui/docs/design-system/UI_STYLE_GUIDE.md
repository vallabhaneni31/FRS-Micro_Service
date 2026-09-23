# Motivity FRS — UI Design System Reference

> Relocated here by `/ml-specs:repo-adopt` — this doc originally lived in `frs-core-api` from
> before the frontend/backend repo split, describing paths under `frontend/`. Those paths now map
> to this repo's `src/` (e.g. `frontend/src/styles/theme.css` → `src/styles/theme.css`). Content
> below is otherwise unchanged from the original; a copy remains in `frs-core-api` for history.

Generated from the live codebase (Aug 2026): `frontend/src/styles/theme.css`, `frontend/src/theme/lightTheme.ts`, the 47-component `frontend/src/app/components/ui/` library, and the responsiveness audit run this session. Companion interactive HTML style guide (light/dark toggle, live component demos): https://claude.ai/code/artifact/2662cf02-d1ee-4451-8933-f49a54e1e53b. A structured token/component inventory is also available alongside this file as `UI_Style_Guide_Inventory.xlsx`.

---

## 1. Color palette

Neutrals come from shadcn-style CSS variables (`theme.css`). Semantic status colors are centralized once in `theme/lightTheme.ts` and are meant to be referenced everywhere rather than re-declared per screen (see [§12 Drift](#12-drift--inconsistencies)).

### Surface & ink

| Token | Light | Dark | CSS variable |
|---|---|---|---|
| Canvas | `#EEF1F6` | `#0B1018` | `--background` (`.app-canvas`) |
| Card / Popover | `#FFFFFF` | `oklch(0.145 0 0)` | `--card` / `--popover` |
| Muted surface | `#ECECF0` | `oklch(0.269 0 0)` | `--muted` |
| Foreground | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | `--foreground` |
| Muted foreground | `#717182` | `oklch(0.708 0 0)` | `--muted-foreground` |
| Border | `rgba(0,0,0,.1)` | `oklch(0.269 0 0)` | `--border` |

### Brand accent

| Token | Value | Notes |
|---|---|---|
| Primary | `#2563EB` (light) / `#3B82F6` (dark) | In-app UI: sidebar active state, buttons, focus rings |
| Auth mark | `orange-500 → amber-500` gradient | Login/auth surface only — hardcoded, no token backing it (flagged in Drift) |

### Status (the one place these should be defined — `lightTheme.status`)

| Status | Color | Text token | Background token |
|---|---|---|---|
| Success | emerald-500 | `text-emerald-600 dark:text-emerald-400` | `bg-emerald-500/10 dark:bg-emerald-500/15` |
| Warning | amber-500 | `text-amber-600 dark:text-amber-400` | `bg-amber-500/10 dark:bg-amber-500/15` |
| Critical | rose-500 | `text-rose-600 dark:text-rose-400` | `bg-rose-500/10 dark:bg-rose-500/15` |
| Info | sky-500 | `text-sky-600 dark:text-sky-400` | `bg-sky-500/10 dark:bg-sky-500/15` |

---

## 2. Typography

Single face app-wide: **Inter**, variable, loaded with the optical-size axis — no separate display face. Sizes below are the real `@layer base` element defaults; Tailwind utilities (`text-sm`, `text-lg`, etc.) override them per instance.

| Role | Size | Weight | Letter-spacing |
|---|---|---|---|
| h1 | `--text-2xl` (~24px) | 500 | -0.02em |
| h2 | `--text-xl` (~20px) | 500 | -0.015em |
| h3 | `--text-lg` (~18px) | 500 | -0.01em |
| h4 | `--text-base` (~16px) | 500 | normal |
| label / button | `--text-base` | 500 | normal |
| input | `--text-base` | 400 | normal |
| eyebrow / uppercase label | 10–11px | 700 | 0.06–0.1em, uppercase |

Utility mono face (guide-only, not present in the app's own UI): **JetBrains Mono** — used here for token names, class strings, and hex values.

---

## 3. Icons

**Lucide React** — imported directly in **162 component files**, no wrapper component or icon registry. Stroke-based (2px, round caps/joins), colored via `currentColor` so an icon always inherits its parent's text color rather than taking its own color prop.

### Size scale (by real usage count across the app)

| Class | Uses | Typical context |
|---|---|---|
| `w-3 h-3` | 163× | Inline with small text, badges |
| `w-4 h-4` | 589× | **Default** — buttons, list rows, form fields |
| `w-5 h-5` | 160× | Nav items, standalone action buttons |
| `w-6 h-6` | 97× | Section/page headers |
| `w-8 h-8` | 103× | Empty states |
| `w-10 h-10`+ | 41×+ | Avatars, feature callouts |

### Conventions

- **Loading**: `Loader2` + `animate-spin` is the app's one spinner convention — no custom spinner SVGs anywhere.
- **Common faces**: `Clock`, `CheckCircle2`, `AlertTriangle`, `User`, `Camera` recur most across verticals.
- Icons never carry their own `fill` — always stroke + `currentColor`, so dark-mode recoloring is automatic via the surrounding text color token.

---

## 4. Material & elevation

The app's signature surface is "liquid glass" — translucent, heavily blurred panels over an ambient dot-grid canvas. Defined once in `theme.css`, reused everywhere:

- **`.app-canvas`** — page background: `#EEF1F6` (light) / `#0B1018` (dark) with a 22px repeating radial-dot texture tied to no specific hue (neutral).
- **`.glass-panel`** — shell chrome (sidebar, header, mobile drawer): `blur(22px) saturate(180%)`, card-tinted translucent background, hairline border, top inset highlight.
- **`.glass-card`** — data-dense surfaces (tables, KPI cards): lighter `blur(16px) saturate(165%)` so text stays crisp.
- Both fall back to a flat opaque `--card` automatically via `@supports not (backdrop-filter)` — no separate no-blur variant needs maintaining.

## 5. Spacing & layout

One radius scale derived from a single base (`--radius: 0.625rem`), never hand-picked per component. Layout leans on flex/grid `gap`, not per-element margins.

| Token | Value | Used for |
|---|---|---|
| `--radius-sm` | `radius - 4px` | small chips |
| `--radius-md` | `radius - 2px` | inputs, buttons, badges |
| `--radius-lg` | `radius` | — |
| `--radius-xl` | `radius + 4px` | nav items, metric cards |
| Cards | `rounded-2xl` (18px) | `Card` primitive |

---

## 6. Animation & transitions

Utility-first, not a hand-rolled animation system.

| Layer | Mechanism | Where |
|---|---|---|
| State changes | Tailwind `transition-colors` / `transition-all`, `duration-200`/`300`/`500` | Hover/focus/active states app-wide |
| Loading | `animate-spin` (`Loader2`), `animate-pulse` (skeletons) | Every async load state |
| Overlay enter/exit | `tw-animate-css`'s `animate-in`/`animate-out` + Radix `data-[state]` hooks (`fade-in-0 zoom-in-95`, 200–300ms) | Dialogs, drawers, dropdowns |
| Richer entrance choreography | Framer Motion (`motion` package) | **Only** 4 files, all under `verticals/retail/` — not an app-wide pattern |
| Reduced motion | Some overlay transitions gated behind `motion-safe:` (e.g. `MobileNav`) | Partial coverage only — see gap below |

### 🟡 Gap: no `prefers-reduced-motion` handling in the app's own CSS
Despite real, frequent animation use, `theme.css` has no `@media (prefers-reduced-motion: reduce)` rule at all — a user with that OS setting gets every animation at full motion regardless. The `motion-safe:` prefixes seen in a few components (like `MobileNav`) only cover those specific spots, not a global rule.

---

## 7. Components

### Buttons (`ui/button.tsx`)

6 variants × 4 sizes. `default` is the only variant carrying the brand accent, so it reads as *the* recommended action per view.

```
<Button variant="default | destructive | outline | secondary | ghost | link" size="sm | default | lg | icon">
```

| Variant | Style |
|---|---|
| `default` | `bg-primary text-primary-foreground` |
| `destructive` | `bg-destructive text-white` |
| `outline` | `border bg-background hover:bg-accent` |
| `secondary` | `bg-secondary text-secondary-foreground` |
| `ghost` | transparent, `hover:bg-accent` |
| `link` | text-only, underline on hover |

### Badges (`ui/badge.tsx`)

Structural variants: `default | secondary | destructive | outline`. Semantic status badges (present/late/absent/on-leave) are built by pairing a badge with `lightTheme.status.*` tokens — see [§12](#12-drift--inconsistencies) for where this pairing gets re-invented per screen instead of shared.

### Forms & inputs (`ui/input.tsx` + friends)

One focus treatment app-wide: a 3px primary-tinted ring (`focus-visible:ring-ring/50 focus-visible:ring-[3px]`), never a color-only border change — keeps keyboard focus visible against glass surfaces. Validation state is signaled via the `aria-invalid` Tailwind variant (`aria-invalid:ring-destructive/20 aria-invalid:border-destructive`), wired directly into the same styling pass as focus — so an invalid field is never colored without also being marked invalid to assistive tech.

### Cards (`ui/card.tsx`, `shared/MetricCard.tsx`)

`Card` anatomy: `CardHeader` → `CardTitle` + `CardDescription` (+ optional `CardAction`) → `CardContent` → `CardFooter`.

`MetricCard` ships **13 pre-mapped color ramps** keyed by a `colorClass` prop (`text-emerald-500`, `text-rose-500`, `text-amber-500`, `text-violet-500`, `text-indigo-500`, `text-blue-500`, `text-teal-500`, `text-orange-500`, plus a `-600` "glass" family) — new KPI tiles pick a key rather than inventing a gradient. Full mapping in `UI_Style_Guide_Inventory.xlsx`.

### Tables & lists (`ui/table.tsx`)

Wraps every table in `overflow-x-auto` by default via an internal container div. Hand-rolled tables that build a `<table>` directly (skipping this primitive) are exactly what the Aug 2026 responsiveness pass went through the codebase fixing.

### Navigation (`shared/Sidebar.tsx`, `shared/MobileNav.tsx`, `shared/AppHeader.tsx`)

One `Sidebar`, two responsive states:
- **≥768px** (`md:`): `hidden md:flex` fixed rail, `w-64` expanded / `w-20` collapsed, `glass-panel` material.
- **<768px**: sidebar fully hidden; a separate `MobileNav` fixed top bar + slide-over drawer takes over (`md:hidden`).

Active nav item: tinted background (`bg-primary/10`), a 3px rounded accent bar on the leading edge, filled/colored icon. Every other state (hover, inactive) stays neutral — color is reserved for "you are here."

### Modals & dialogs (`ui/dialog.tsx`, `ui/sheet.tsx`)

- `Dialog` defaults to `w-full max-w-lg` — shrinks safely on its own; most call sites never need a width override.
- `Sheet` (drawer) defaults to `w-3/4 sm:max-w-sm`; correctly-built call sites override to `w-full sm:max-w-md` so the drawer is edge-to-edge on a phone rather than three-quarters width with a dead margin.

### Alerts & notifications (`ui/alert.tsx`, `ui/sonner.tsx`)

Two distinct systems, easy to conflate:

1. **`Alert` / `AlertTitle` / `AlertDescription`** (`ui/alert.tsx`) — inline, in-page banners. Two variants: `default` (`bg-card`, neutral) and `destructive` (error-tinted). Used for persistent, in-context messages (form-level errors, empty-state explanations).
2. **Sonner toast** (`toast.success/error/info`, `ui/sonner.tsx`) — transient, corner-anchored system feedback for the outcome of an action ("Password changed successfully"). Themed via CSS variables mapped straight to the popover tokens (`--normal-bg: var(--popover)`, etc.), so it always matches the current light/dark theme automatically.

Neither of these is the same thing as the **Alert Center** *feature* (`frs_alert`/`system_alert` DB tables, `AlertCenterPage.tsx`) — that's a business-domain alert feed (security/system events), built out of the same `Badge` + `Card` + `Table` primitives, not a separate UI component.

---

## 8. Responsive rules

Default Tailwind breakpoints throughout: `sm` 640 / `md` 768 / `lg` 1024 / `xl` 1280. Three concrete rules came directly out of this session's breakpoint audit:

1. **Every table gets a scroll container, not a clip.** Wrap in `overflow-x-auto` (on `CardContent`, or a dedicated inner `div` when other content shares the card) — never a bare `overflow-hidden` on a table's parent.
2. **Stat/photo grids collapse before they crush.** A 3–4 column KPI row → `grid-cols-2 sm:grid-cols-4`. Wider photo grids (5–8 across) → `grid-cols-3 sm:grid-cols-5` or `grid-cols-4 sm:grid-cols-8`. Pick the phone column count by what stays legible, not by blindly halving.
3. **Header rows stack before they overflow.** A title + search + action-buttons row → `flex flex-col sm:flex-row sm:items-center justify-between gap-3`; any fixed-width search input → `w-full sm:w-[240px]`.

---

## 9. Page templates

Three shapes cover almost every screen across all four verticals (corporate, education, retail, transport):

| Template | Anatomy | Examples |
|---|---|---|
| **List / management page** | `PageHeader` (icon + title + subtitle + right-aligned actions) → filter row → one `Card` containing a `Table` → pagination footer | Every `*Management.tsx` |
| **Dashboard** | `PageHeader` → responsive `MetricCard` row → chart card(s) → detail table below the fold | `HRManagerDashboard`, `RetailDashboard`, `SuperAdminDashboard` |
| **Detail drawer** | `Sheet` from the right: identity header → small stat grid → scrollable timeline/list | `EmployeeHistoryDrawer`, `EmployeeTimesheetDrawer` |

---

## 10. Accessibility

- **Baseline comes from Radix UI**, not hand-rolled ARIA — `Dialog`, `DropdownMenu`, `Tooltip`, `Accordion`, `Select`, and every other Radix-backed primitive in `ui/` gets focus trapping, correct roles, and keyboard navigation for free, without each screen re-implementing it.
- **One focus-ring treatment everywhere**: `focus-visible:ring-ring/50 focus-visible:ring-[3px]`, identical across buttons, inputs, and badges — keyboard focus is never signaled by color alone, and stays visible against the glass material's translucency.
- **`aria-invalid`** is wired directly into form-control styling (`aria-invalid:ring-destructive/20 aria-invalid:border-destructive`) — an invalid field's visual and assistive-tech state can't drift apart.
- **`aria-label`** is applied ad hoc on icon-only buttons (nav toggles, pagination, close buttons) — present but not governed by a checklist, so coverage varies by screen.
- 🟡 **Gap**: no `prefers-reduced-motion` support at the app level — see [§6](#6-animation--transitions).

---

## 11. Theming & skins

Two independent layers exist — one fully wired up, one only half-built:

### Light / dark (real, wired end-to-end)
`ThemeContext` toggles a `.dark` class on `<html>`, which flips every CSS variable in `theme.css`'s `:root` / `.dark` blocks. The choice persists to `localStorage` **and** syncs server-side via `PATCH /me/preferences` — so it follows the user across devices, not just the browser.

### Per-tenant branding (persisted, but not applied)
`TenantUiSettings.tsx` lets a tenant admin set a custom `primaryColor` (defaults to `#6366f1` — notably *not* the app's own `#2563EB` default) and a `logoUrl`, saved to the `tenant_ui_config` table via the tenant-admin API.

🔴 **Finding**: nothing in the frontend actually *applies* that saved `primaryColor` at runtime — no code sets `--primary` (or any token) from it. Today this is a settings form that persists data nobody reads back. Either the consuming code was never built, or it regressed — worth a decision on whether tenant re-branding is still a live goal before more work goes into that settings screen.

---

## 12. Drift & inconsistencies

What this pass found *not* matching the system above — worth cleaning up, not a reason to distrust the tokens.

### 🟡 Status colors re-declared per screen
`theme/lightTheme.ts` centralizes success/warning/error/info once, but several screens define their own local `STATUS_BADGE` / `SEVERITY_STYLES` object with the same colors hand-typed again — a future palette change means hunting down every copy instead of editing one file.
Files: `FleetManagement.tsx`, `IncidentListPage.tsx`, `AlertCenterPage.tsx`, transport `UserManagement.tsx`.

### 🟡 Two brand accents, one undocumented
The login/auth surface runs entirely on a hardcoded orange→amber gradient (`from-orange-500 to-amber-500`) with no token behind it, while the rest of the app runs on the blue `--primary` CSS variable. Whether this is an intentional "auth surface has its own identity" decision or a leftover from an earlier direction isn't written down anywhere.
Files: `LoginPage.tsx` vs. `theme.css --primary`.

### 🟡 Two parallel theming abstractions
Most screens read colors through the semantic `lightTheme.*` object; a subset reach past it to hardcoded Tailwind slate/gray classes (`text-slate-800 dark:text-white`) that happen to look right today but won't move if the neutral ramp ever changes.
Files: `HRManagerDashboard.tsx`, `AttendanceStatusDashboard.tsx`.

### 🔴 Tenant branding settings are write-only
See [§11](#11-theming--skins) — `TenantUiSettings.tsx` saves a custom primary color and logo that nothing in the frontend reads back.

---

*Source of truth for the tokens above is always the code, not this document — regenerate/re-audit if `theme.css` or `lightTheme.ts` change materially.*
