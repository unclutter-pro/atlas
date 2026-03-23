# Visual Artifacts

Posters, infographics, covers, art pieces, visual identities, diagrams, social graphics — static visual output as PDF or PNG.

This surface differs from documents and applications: the output is primarily **visual expression**, not information delivery. Text is a design element, not content.

---

## The Approach: Philosophy → Expression

### 1. Create a Design Philosophy

Before any visual work, write a short manifesto (4-6 paragraphs) that defines the aesthetic language. This isn't decoration planning — it's establishing a visual worldview.

**Name the movement** (1-2 words): "Brutalist Joy" / "Chromatic Silence" / "Metabolist Dreams"

**Articulate through:**
- Space and form — how elements occupy the canvas
- Color and material — the chromatic vocabulary
- Scale and rhythm — repetition, contrast, visual tempo
- Composition and balance — where tension lives
- Visual hierarchy — what leads, what whispers

**Critical:** Emphasize craftsmanship repeatedly. The final work must appear meticulously crafted, the product of deep expertise. This framing directly impacts output quality.

### 2. Deduce the Conceptual Thread

Identify the subtle reference from the user's request. This becomes the soul of the piece — a niche reference embedded within the art, not announced. Someone familiar with the subject should feel it intuitively. Others simply experience a masterful composition.

Think like a jazz musician quoting another song — only those who know will catch it.

### 3. Express on Canvas

Use the philosophy to guide a single-page (or multi-page) visual artifact.

---

## Color System

- **1 primary + 1 accent + 3-5 shades of grey.** Maximum 6 distinct colors in any single piece.
- **Sequential scales** (light-to-dark of one hue) for ordered data in infographics.
- **Categorical palettes** (distinct hues at similar saturation/brightness) for categories.
- **Colors must have distinctly different brightness values.** When colors compete at similar brightness, the palette feels muddy.
- **Never pure black or white.** Tint neutrals warm or cool with <5% HSB saturation.

---

## Visual Hierarchy

- **Primary element 2-3× larger** than secondary elements. The focal point must be unmistakable.
- **Proximity > lines for showing relationships.** Group related items with 8-12px gaps; separate groups with 32-48px gaps. AI uses connector lines everywhere when spacing alone would communicate.
- **Chunking for complex information:** Break into groups of 3-5 items (Miller's Law). AI generates long undifferentiated lists.
- **Arrange elements heaviest-first, lightest-last** in reading direction.

---

## Typography in Visual Artifacts

- **Text is sparse, essential-only, integrated as visual accent** — never explanatory
- Let context guide scale: a punk venue poster has aggressive type; a ceramics identity whispers
- Most of the time, font weight should be thin and deliberate
- **Use different fonts** — search available system fonts for character
- **Minimum text size: 11px, ideally 12-14px** for any readable text
- **Labels directly on data points** — never in a separate legend if avoidable
- **Two typefaces maximum** even in visual pieces

---

## Composition Rules

- Nothing falls off the page, nothing overlaps unintentionally
- Every element contained within canvas boundaries with proper margins
- Breathing room and clear separation between all elements — non-negotiable
- Anchor with simple phrases or details positioned subtly
- Limited color palette that feels intentional and cohesive
- **Alignment to an invisible grid** that creates order without visible structure

---

## Consistency Details

These separate professional work from amateur:

- **Consistent stroke weights:** 1px subtle, 2px standard, 3px emphasis. Don't mix randomly.
- **Consistent icon style:** all outline, all filled, all duotone — never mixed.
- **Consistent annotation style:** thin leader lines (1px, grey), small text, placed consistently (always above, or always to the right).
- **White space as a design element**, not leftover area.
- **Semantic color usage:** red for negative/warnings, green for positive/success, blue for neutral — applied consistently.

---

## Platform-Specific Sizes

| Platform | Dimensions | Ratio |
|----------|-----------|-------|
| Instagram post | 1080×1080 | 1:1 |
| Instagram story | 1080×1920 | 9:16 |
| Twitter/X | 1200×675 | 16:9 |
| LinkedIn | 1200×627 | ~2:1 |
| OG image | 1200×630 | ~2:1 |
| A4 poster | 2480×3508 | ~1:√2 |
| US Letter | 2550×3300 | ~1:1.29 |

---

## Quality Bar

- Museum or magazine quality — not decorative, not cartoony, not amateur
- Every alignment the work of countless refinements
- After first pass, always take a second pass to refine and polish
- Ask: "How can I make what's already here more cohesive?" before adding more elements
- Treat the composition as if it were a scientific diagram from an imaginary discipline — dense accumulation of marks, repeated elements, layered patterns that build meaning

---

## Philosophy Examples

**"Concrete Poetry"** — Communication through monumental form. Massive color blocks, sculptural typography, Brutalist spatial divisions. Text as rare, powerful gesture.

**"Chromatic Language"** — Color as primary information system. Geometric precision, minimal sans-serif labels, information encoded spatially and chromatically. Josef Albers meets data visualization.

**"Analog Meditation"** — Quiet visual contemplation through texture. Paper grain, vast negative space, photography dominates. Japanese photobook aesthetic.

**"Organic Systems"** — Natural clustering and modular growth. Rounded forms, color from nature through architecture. Information shown through spatial relationships and iconography.

**"Geometric Silence"** — Pure order and restraint. Grid-based precision, dramatic negative space. Swiss formalism meets Brutalist material honesty.

---

## Output

- Single-page PDF or PNG (default)
- Multi-page: treat as a coffee table book — each page a unique twist on the philosophy, almost telling a story
- Save design philosophy as `.md` alongside the artifact
- Always save to `~/output/`

## Implementation

Use Playwright for complex canvas compositions (HTML → PDF/PNG), or Typst for typography-driven pieces. For generative/algorithmic elements, write self-contained HTML with inline CSS and JS.

---

## What AI Gets Wrong in Visual Artifacts

- Overuses decoration (gradients, shadows, rounded everything) where clarity matters
- Too many colors with no system — limit to 6 distinct colors
- All elements the same size — no hierarchy
- Connector lines everywhere instead of using proximity
- Random stroke widths instead of a consistent scale
- Mixed icon styles (outline + filled + duotone in the same piece)
- Tiny, unreadable labels
- Symmetry addiction — professional work uses asymmetry for visual interest
