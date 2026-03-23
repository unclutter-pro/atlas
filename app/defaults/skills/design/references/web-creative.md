# Web Creative Reference

Marketing sites, landing pages, campaigns, creative web. This is where boldness lives.

---

## Aesthetic Direction

Commit to a BOLD direction and execute with precision. Pick a position on the spectrum:

- Brutally minimal — stripped to structure, type does the heavy lifting
- Maximalist — layered, textured, rich with detail
- Retro-futuristic — nostalgia meets forward motion
- Organic/natural — flowing shapes, earthy texture
- Luxury/refined — restrained opulence, deliberate negative space
- Editorial/magazine — grid-breaking layouts, type-as-hero
- Brutalist/raw — exposed structure, confrontational clarity
- Art deco/geometric — precision, pattern, metallic warmth
- Playful/toy-like — rounded, bouncy, saturated
- Industrial/utilitarian — function visible, nothing hidden

These are starting points, not destinations. Design a direction true to the project, not a style from a list.

---

## Typography

Choose fonts that are distinctive and characterful. The typography IS the design — not a container for it.

- **Pair with purpose:** A display font for headlines, a refined font for body. The contrast between them creates energy.
- **Never default:** If your first instinct is Inter, Space Grotesk, or Roboto — stop. Those are patterns, not choices.
- **Scale dramatically:** Use Perfect Fourth (1.333) or higher ratio. For a 16px base: 16, 21, 28, 38, 51, 68px. AI defaults to timid scales where headings barely differ from body text.
- **Track tightly on display sizes.** Letter-spacing compresses as size increases — this is what makes large type feel intentional rather than just big. Headlines above 36px: `-0.02em` to `-0.04em`. Body text: `0` to `0.01em`.
- **Two typefaces maximum.** One display, one text. A third is noise.

---

## Spacing: Dramatic Contrast

This is the single biggest difference between AI output and professional design.

- **Tight within groups** (8-16px) but **enormous gaps between sections** (120-200px). The ratio between inner and outer spacing should be at least 4:1.
- AI tendency: uniform 40-60px gaps everywhere. This flattens the page into a monotone rhythm.
- Build a spacing scale on multiples of 8: 8, 16, 24, 32, 48, 64, 96, 128, 192. Use the full range.
- **Outer padding ≥ inner padding** in any container.

---

## Spatial Composition

Break expectations. The web is not a vertical stack of centered sections.

- **Asymmetry** — offset grids, uneven columns, deliberate imbalance
- **Overlap** — elements that cross boundaries create depth and connection
- **Diagonal flow** — the eye doesn't have to travel straight down
- **Grid-breaking elements** — one element that escapes the system draws attention
- **Generous negative space** OR **controlled density** — both work, but "comfortable medium" is forgettable
- **Proportion declares importance** — a full-viewport hero says "this matters." A modest header says "get to the content."

---

## Color

- **Never use pure black (#000) or pure white (#FFF).** Use near-black and near-white. Add <5% saturation in HSB to neutrals, tinting warm or cool — never mixing both.
- **Define 5+ greys** (e.g., 50/100/200/400/600/800/950 shades). Use no more than 2 accent colors.
- **Colors in a palette must have distinctly different brightness values.** When colors compete at similar brightness, the palette feels muddy.
- **Replace borders with spacing and background shifts.** Alternatives to borders: box shadows (`0 1px 3px rgba(0,0,0,0.1)`), 3-5% brightness difference, or 24-32px whitespace.
- **Accent borders for punch:** A 3-4px colored top or left border on a card adds personality with minimal complexity.

---

## Shadows

Professional shadows are **layered** (two shadows combined), use **negative spread**, and stay at **0.1 opacity or below**:

| Level | CSS |
|-------|-----|
| Subtle | `0 1px 2px 0 rgb(0 0 0 / 0.05)` |
| Small | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` |
| Medium | `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` |
| Large | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` |
| XL | `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)` |

Shadow rule: **blur = 2× the Y-offset.** A shadow extending 4px on Y-axis needs 8px blur.

**No shadows in dark interfaces.** They don't function visually — use brightness and border differences instead.

---

## Motion

Motion creates narrative on the web. Use it to tell a story, not to decorate.

- **Page load orchestration** — staggered reveals with `animation-delay` create a choreographed entrance
- **Scroll-triggered reveals** — content that appears as you reach it rewards exploration. But don't animate everything — choose moments
- **Hover surprise** — interactive elements that respond unexpectedly create discovery. Shadow-sm to shadow-md on hover with 150ms ease
- **Parallax with restraint** — subtle depth shifts between layers. Heavy parallax feels dated; light parallax feels dimensional

Prioritize CSS-only solutions. Use animation libraries (Motion, GSAP) when the project supports them.

---

## Backgrounds and Atmosphere

Solid color backgrounds are the default. Defaults are what you're avoiding.

- **Gradient meshes** — complex, organic color transitions
- **Noise textures** — subtle grain adds physical quality
- **Geometric patterns** — structured repetition at low opacity
- **Layered transparencies** — overlapping semi-transparent shapes
- **Grain overlays** — a thin noise layer on everything unifies disparate elements

The background sets the stage. A distinctive atmosphere is half the design.

---

## Button & Control Details

- **Button padding: horizontal = 2× vertical** (e.g., 12px 24px, or 16px 32px)
- **Nested border-radius: inner = outer minus gap.** Container with 16px radius and 8px padding → inner elements get 8px radius.
- **Reduce icon opacity to 0.7** when icons appear next to text — prevents them from competing visually
- **Responsive type scaling**: use different ratios per breakpoint (1.200 on mobile, 1.333 on desktop)

---

## Anti-Patterns

These signal "AI-generated" immediately:

- Purple gradients on white backgrounds
- Inter/Roboto/Arial as the primary typeface
- Centered sections with identical padding stacked vertically
- Hero → features grid → testimonials → CTA (the template)
- Gradient text on headings with no other color commitment
- Stock illustration style (flat, geometric, lifeless)
- Cookie-cutter card grids with icon + heading + paragraph
- Safe color palette with no personality
- Dead-neutral greys with no warm or cool tinting
- Uniform spacing everywhere with no dramatic contrast
- Pure symmetry — everything perfectly centered

If your output matches three or more of these, start over.

---

## The Creative Test

Before showing the user, ask: if ten different AI tools were given this prompt, would they produce something that looks like this?

If yes, you haven't designed. You've templated.

Creative web is where you prove that design is a choice, not a pattern. Every project should look like nothing else you've made.
