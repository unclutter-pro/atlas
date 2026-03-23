# Applications Reference

SaaS apps, dashboards, admin panels, tools, settings pages, data interfaces. This is where subtle layering defines craft.

---

## The Subtle Layering Principle

This is the backbone. When you look at Vercel's dashboard, you don't think "nice borders." You just understand the structure. When you look at Linear, you don't think "good elevation." You just know what's above what. The craft is invisible — that's how you know it's working.

---

## Spacing System

Lock to a 4px grid. Every margin, padding, and gap must be from this scale:

```
4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96
```

No exceptions. No `13px` or `37px`. This is the single biggest differentiator between amateur and professional app UI.

---

## Type Scale

Use Major Second (1.125) or Minor Third (1.200). Apps need subtler hierarchy than marketing pages.

For 14px base with 1.200 ratio: **14, 17, 20, 24, 29, 35px**

Rules:
- Bigger text → tighter letter-spacing and line-height
- Smaller text → looser letter-spacing and line-height
- Headlines: `line-height: 1.1-1.2`, `letter-spacing: -0.02em`
- Body: `line-height: 1.5-1.6`, `letter-spacing: 0`
- Labels/captions: `line-height: 1.4`, `letter-spacing: 0.01em`

---

## Surface Elevation

Surfaces stack. Build a numbered system:

```
Level 0: Base background (the app canvas)
Level 1: Cards, panels (slight lift from base)
Level 2: Dropdowns, popovers (floating above)
Level 3: Nested overlays, stacked popovers
Level 4: Highest elevation (rare)
```

**Container brightness differences:**
- Light mode: max **7%** brightness difference between nested surfaces
- Dark mode: max **12%** brightness difference
- Higher elevation = slightly lighter in dark mode

**Concrete values:**
- Light mode: page `#F8F9FA`, card `#FFFFFF`, elevated card with shadow-sm
- Dark mode: page `#0F1117`, card `#1A1D27`, elevated `#252836`

**Key decisions:**
- **Sidebars:** Same background as canvas, not different. Different colors fragment visual space. A subtle border is enough separation.
- **Dropdowns:** One level above their parent. If both share the same level, the dropdown blends in.
- **Inputs:** Slightly darker than surroundings, not lighter. Inputs are "inset" — they receive content.

---

## Shadows

Use the layered shadow scale from web-creative reference. Key difference for apps:

- **No shadows in dark interfaces.** Use brightness steps and borders instead.
- Pick ONE depth approach and commit: flat (borders only), subtle shadows, or layered shadows. Never mix.
- Shadow blur = 2× the Y-offset.

---

## Borders

Borders should disappear when you're not looking for them, but be findable when you need structure. Low-opacity rgba blends with the background.

Build a progression:
- **Default** — standard separation: `1px solid rgba(0,0,0,0.08)`
- **Subtle** — softer, background grouping: `1px solid rgba(0,0,0,0.04)`
- **Strong** — emphasis, hover states: `1px solid rgba(0,0,0,0.15)`
- **Stronger** — focus rings: `2px solid var(--brand)`

**Borders must contrast with BOTH the container AND the background**, not split the difference.

**Replace borders when possible:** spacing (24-32px), subtle background shift (3-5% brightness), or refined shadow (shadow-sm) communicate separation without visual noise.

---

## Colors

- **Never pure black or pure white.** Tint neutrals warm or cool with <5% HSB saturation.
- **5+ grey shades minimum.** Body text in near-black (e.g., `#1A1A2E`), secondary in mid-grey, muted in light-grey.
- **One accent color, used with intention.** Primary action buttons, active nav states, selection indicators — all the same color.
- **Von Restorff Effect for primary actions:** The main CTA must differ visually from all other buttons. Filled primary among outlined/ghost secondaries.
- **Semantic colors:** red for destructive, amber for warning, green for success, blue for info. Desaturate these slightly in dark mode.

---

## Card Layout Variation

A metric card doesn't have to look like a plan card doesn't have to look like a settings card. Design each card's internal structure for its specific content — but keep surface treatment consistent: same border weight, shadow depth, corner radius, padding scale.

Every pattern has infinite expressions. A metric display could be a hero number, sparkline, gauge, progress bar, comparison delta, or trend badge.

**Before building, ask:**
- What's the ONE thing users do most here?
- What products solve similar problems brilliantly? Study them.
- Why would this feel designed for its purpose, not templated?

---

## Navigation Context

Screens need grounding. A data table floating in space is a component demo, not a product.

- **Navigation** — sidebar or top nav showing where you are
- **Location indicator** — breadcrumbs, page title, active nav state
- **User context** — who's logged in, what workspace/org
- **Serial Position Effect:** put critical actions first and last in nav lists. Users remember these best.

---

## Controls

- **Button padding: horizontal = 2× vertical** (12px 24px, 16px 32px)
- **Nested border-radius:** inner = outer minus gap
- **Custom select/date picker** — native `<select>` and `<input type="date">` can't be styled. Build custom components.
- Custom select triggers need `display: inline-flex` with `white-space: nowrap`

---

## Information Density

Density is a design decision. Consider the user's context:

- **High density** — trading floors, developer tools, monitoring dashboards. Tight spacing, 12-14px text, 36-44px row height, 12-16px cell padding.
- **Medium density** — most SaaS products. Balanced breathing room with functional depth.
- **Low density** — consumer apps, onboarding flows. Generous space, progressive disclosure.

**Hick's Law:** Limit choices per view. Group related actions. Use progressive disclosure. Don't dump all controls on one screen.

**Miller's Law:** 7±2 items in working memory. Chunk navigation and options into groups of 3-5.

---

## States — The Missing Design

Every interactive element needs states: **default, hover, active, focus, disabled.** Data needs states: **loading, empty, error.** Missing states feel broken.

AI almost never generates these. But this is where real apps spend most of their visual complexity:

- **Empty states:** Helpful illustration + clear CTA. Not just "No data found."
- **Loading:** Skeleton screens matching actual content layout, not generic spinners.
- **Error:** Specific message + what the user can do about it.
- **Hover:** Subtle shadow transition (shadow-sm → shadow-md, 150ms ease) or background shift.

**Doherty Threshold:** Show loading states within 400ms. Users perceive anything slower as laggy.

---

## Dark Mode

Dark interfaces have different needs:

- **Borders over shadows** — shadows barely register on dark backgrounds
- **Desaturate semantics** — success, warning, error colors need slight desaturation
- **Invert the hierarchy** — higher elevation = slightly lighter
- **Watch contrast** — pure white text on pure black is harsh. Soften both ends
- **No shadows** — use brightness differences between surfaces instead

---

## Application Types

The same fundamentals apply everywhere, but emphasis shifts. Know what kind of app you're designing:

### Data-Heavy Tools (Dashboards, Analytics, Admin Panels)

Priority: **density and scanability.** Users spend hours here daily. Every pixel earns its place.

- **Typography:** 12-14px body, tight line-height (1.3-1.4). Tabular numbers (`font-variant-numeric: tabular-nums`).
- **Row height:** 36-44px in tables. Compact cell padding (8-12px).
- **Layout:** Fixed sidebars, persistent filters, multi-column layouts. Users expect stability — things don't move.
- **Color:** Minimal. Grey-dominant with semantic colors only for status. Accent color reserved for active states.
- **Patterns:** Sortable tables, faceted filters, bulk actions, export controls, keyboard shortcuts.
- **Reference:** Linear, Vercel Dashboard, Datadog, Grafana.

### Consumer / End-User Apps

Priority: **clarity and delight.** Users may be new. First impression matters. Onboarding matters.

- **Typography:** 16px body, generous line-height (1.5-1.6). Friendly, readable fonts.
- **Spacing:** Generous whitespace. Cards with 24-32px padding. Sections separated by 48-64px.
- **Layout:** Single-column or simple 2-column. Progressive disclosure — show basics, reveal advanced.
- **Touch targets:** 44px minimum on everything interactive. Generous hit areas.
- **Onboarding:** Empty states that educate. Contextual tips. Feature discovery that doesn't annoy.
- **Patterns:** Bottom navigation on mobile, clear primary actions, social proof, streak/reward mechanics.
- **Reference:** Notion (consumer mode), Spotify, Duolingo, Airbnb.

### Internal Tools (Back-office, CRM, Operations)

Priority: **efficiency over aesthetics.** Power users who need speed. They'll tolerate density but not inefficiency.

- **Typography:** 13-14px body. Compact but not cramped.
- **Layout:** Master-detail views, split panes, collapsible sections. Navigation that exposes the full feature set.
- **Forms:** Dense multi-field layouts, inline editing, batch operations. Reduce clicks.
- **Keyboard:** Heavy keyboard support. Tab through fields, Enter to submit, Escape to cancel. Command palette (Cmd+K).
- **Polish:** Functional over decorative. Skip the illustrations and micro-animations. Focus on fast state transitions and reliable feedback.
- **Patterns:** Multi-select, drag-to-reorder, inline validation, saved filters, audit logs.
- **Reference:** Retool, Salesforce Lightning, GitLab.

### Choosing the Right Density

When in doubt, start medium and adjust based on:
- **Session length:** Longer sessions → higher density (users learn the interface)
- **Task frequency:** Daily use → optimize for speed. Monthly use → optimize for discoverability
- **User expertise:** Experts tolerate and prefer density. Beginners need space and guidance
- **Data volume:** More data → tighter spacing, smaller text, compact controls

---

## Avoid

- Harsh borders — if borders are the first thing you see, they're too strong
- Dramatic surface jumps — elevation changes should be whisper-quiet (max 7% light, 12% dark)
- Different hues for different surfaces — same hue, shift only lightness
- Pure white cards on colored backgrounds
- Decorative borders or gradients — color should mean something
- Same sidebar width, same card grid, same metric boxes every time — this signals AI immediately
- Uniform spacing — professional design uses dramatic spacing contrast between groups and within groups
- Dead-neutral greys — always tint warm or cool
