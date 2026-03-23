---
name: design
description: Design any visual output — websites, landing pages, SaaS apps, dashboards, documents, reports, presentations, posters, infographics, or any UI/layout/typography/color work. Use when the user asks to build, design, style, or create anything visual, even if they don't explicitly say "design." Also use for visual artifacts like posters, covers, art pieces, and infographics.
---

# Design

Build visual output with craft and intentionality.

**Use for:** Websites, landing pages, SaaS apps, dashboards, admin panels, tools, documents, reports, presentations, data visualizations — anything visual.

---

# The Problem

You will generate generic output. Your training has seen thousands of interfaces. The patterns are strong.

You can follow the entire process below — explore the domain, name a signature, state your intent — and still produce a template. Warm colors on cold structures. Friendly fonts on generic layouts. "Clean and modern" that looks like every other AI output.

This happens because intent lives in prose, but code generation pulls from patterns. The gap between them is where defaults win.

The process below helps. But process alone doesn't guarantee craft. You have to catch yourself.

---

# Where Defaults Hide

Defaults don't announce themselves. They disguise themselves as infrastructure — parts that feel like they just need to work, not be designed.

**Typography feels like a container.** Pick something readable, move on. But typography isn't holding your design — it IS your design. The weight of a headline, the personality of a label, the texture of a paragraph. These shape how the output feels before anyone reads a word. A bakery management tool and a trading terminal might both need "clean, readable type" — but the type that's warm and handmade is not the type that's cold and precise.

**Layout feels like scaffolding.** Build the structure, add the content, get to the real work. But layout isn't around your design — it IS your design. Proportions declare what matters. A 280px sidebar next to full-width content says "navigation serves content." A 360px sidebar says "these are peers." If you can't articulate what your proportions are saying, they're not saying anything.

**Color feels like decoration.** Pick a palette, apply it. But color isn't applied TO something — it comes FROM somewhere. Every product exists in a world. That world has colors. Your palette should feel like it emerged from the domain, not like it was selected from a color picker.

**Token names feel like implementation detail.** But your CSS variables are design decisions. `--ink` and `--parchment` evoke a world. `--gray-700` and `--surface-2` evoke a template. Someone reading only your tokens should be able to guess what product this is.

The trap is thinking some decisions are creative and others are structural. Everything is design. The moment you stop asking "why this?" is the moment defaults take over.

---

# Intent First

Before any visual work, answer these. Not in your head — out loud, to yourself or the user.

**Who is this human?**
Not "users." The actual person. Where are they when they see this? What's on their mind? A teacher at 7am with coffee is not a developer debugging at midnight is not a founder between investor meetings. Their world shapes every choice.

**What must they accomplish?**
Not "use the app" or "read the page." The verb. Grade these submissions. Find the broken deployment. Sign up for the product. Understand Q3 performance. The answer determines what leads, what follows, what hides.

**What should this feel like?**
Say it in words that mean something. "Clean and modern" means nothing — every AI says that. Warm like a notebook? Cold like a terminal? Dense like a trading floor? Calm like a reading app? Bold like a magazine spread? The answer shapes color, type, spacing, density — everything.

**What is the context?**
Screen or print? Projected or handheld? Browsed casually or studied closely? Read once or used daily? Context constrains every decision.

If you cannot answer these with specifics, stop. Ask the user. Do not guess. Do not default.

## Every Choice Must Be A Choice

For every decision, you must be able to explain WHY.

- Why this layout and not another?
- Why this color temperature?
- Why this typeface?
- Why this spacing scale?
- Why this information hierarchy?

If your answer is "it's common" or "it's clean" or "it works" — you haven't chosen. You've defaulted.

**The test:** If you swapped your choices for the most common alternatives and the design didn't feel meaningfully different, you never made real choices.

## Sameness Is Failure

If another AI, given a similar prompt, would produce substantially the same output — you have failed.

This is not about being different for its own sake. It's about the output emerging from the specific problem, the specific user, the specific context. When you design from intent, sameness becomes impossible because no two intents are identical.

---

# Domain Exploration

This is where defaults get caught — or don't.

Generic output: Task type → Visual template → Theme
Crafted output: Task type → Product domain → Signature → Structure + Expression

The difference: time in the product's world before any visual thinking.

## Required Outputs

**Do not propose any direction until you produce all four:**

**Domain:** Concepts, metaphors, vocabulary from this product's world. Not features — territory. Minimum 5.

**Color world:** What colors exist naturally in this domain? Not "warm" or "cool" — go to the actual world. If this were a physical space, what would you see? What colors belong here that don't belong elsewhere? List 5+.

**Signature:** One element — visual, structural, or interactive — that could only exist for THIS project. If you can't name one, keep exploring.

**Defaults to reject:** 3 obvious choices for this type of output — visual AND structural. You can't avoid patterns you haven't named.

## Proposal Requirements

Your direction must explicitly reference:
- Domain concepts you explored
- Colors from your color world exploration
- Your signature element
- What replaces each default

**The test:** Read your proposal. Remove the project name. Could someone identify what this is for? If not, it's generic. Explore deeper.

---

# Universal Design Principles

These apply regardless of surface type. This is the quality floor.

## Token Architecture

Every color should trace back to a small set of primitives: foreground (text hierarchy), background (surface elevation), border (separation hierarchy), brand, and semantic (destructive, warning, success). No random hex values — everything maps to primitives.

### Text Hierarchy

Build four levels — primary, secondary, tertiary, muted. Each serves a different role: default text, supporting text, metadata, and disabled/placeholder. Use all four consistently. If you're only using two, your hierarchy is too flat.

### Border Progression

Build a scale that matches intensity to importance — standard separation, softer separation, emphasis, maximum emphasis for focus rings. Not every boundary deserves the same weight.

### Control Tokens

Form controls have specific needs. Don't reuse surface tokens — create dedicated ones for control backgrounds, control borders, and focus states. This lets you tune interactive elements independently.

## Typography

Build distinct levels distinguishable at a glance. Headlines need weight and tight tracking for presence. Body needs comfortable weight for readability. Labels need medium weight that works at smaller sizes. Data needs monospace with tabular number spacing for alignment. Don't rely on size alone — combine size, weight, and letter-spacing.

Choose fonts with intention. Avoid generic choices (Inter, Roboto, Arial, system fonts) unless they genuinely serve the domain. A distinctive display font paired with a refined body font creates character. Vary choices between projects — never converge on the same typeface across different work.

## Color Carries Meaning

Gray builds structure. Color communicates — status, action, emphasis, identity. Unmotivated color is noise. One accent color, used with intention, beats five colors used without thought.

**Beyond warm and cold:** Temperature is one axis. Is this quiet or loud? Dense or spacious? Serious or playful? A trading terminal and a meditation app are both "focused" — completely different kinds of focus. Find the specific quality, not the generic label.

## Spacing System

Pick a base unit and stick to multiples. Build a scale: micro spacing (icon gaps), component spacing (within buttons and cards), section spacing (between groups), major separation (between distinct areas). Random values signal no system.

## Depth and Elevation

Choose ONE approach and commit:
- **Borders-only** — Clean, technical. For dense tools.
- **Subtle shadows** — Soft lift. For approachable products.
- **Layered shadows** — Premium, dimensional. For cards that need presence.
- **Surface color shifts** — Background tints establish hierarchy without shadows.

Don't mix approaches. Surfaces stack: base, then increasing elevation. In dark mode, higher elevation = slightly lighter. The jumps should be whisper-quiet — a few percentage points of lightness, not dramatic shifts.

## Motion and States

Every interactive element needs states: default, hover, active, focus, disabled. Data needs states: loading, empty, error. Missing states feel broken.

Keep animation fast and functional. Micro-interactions ~150ms, larger transitions 200-250ms. Use deceleration easing. Avoid spring/bounce in professional contexts.

---

# Surface Routing

Different outputs have different needs. After establishing intent and domain, consult the appropriate reference:

**Websites and landing pages** — Marketing sites, creative web, campaigns. Bold aesthetic choices, scroll-driven storytelling, distinctive spatial composition.
→ See `references/web-creative.md`

**Applications** — SaaS, dashboards, admin panels, tools. Subtle layering, information density, interaction patterns.
→ See `references/applications.md`

**Documents** — Reports, data visualizations, print/PDF output. Page structure, long-form typography, chart design.
→ See `references/documents.md`

**Presentations** — Slide decks, pitch materials, keynotes. Visual storytelling, projection readability, slide hierarchy.
→ See `references/presentations.md`

**Visual artifacts** — Posters, infographics, covers, art pieces, visual identities. Philosophy-driven visual expression where text is a design element, not content. Museum-quality static output. Design-forward fonts available in `canvas-fonts/`.
→ See `references/visual-artifacts.md`

**Accessibility & responsive design** — Contrast ratios, touch targets, keyboard navigation, color-blind safety, responsive breakpoints, mobile-first patterns. Applies across all surfaces.
→ See `references/accessibility.md`

When a project spans multiple surfaces (e.g., marketing site + dashboard), maintain shared tokens and identity across them while adapting expression to each surface's needs.

---

# Working with Existing Guidelines

Before starting, check for existing design context:

1. **Design system files** — Look for existing tokens, component libraries, style guides in the project
2. **Project instructions** — Check CLAUDE.md or similar for brand colors, typography preferences, design direction
3. **Explicit user instructions** — Brand guidelines, mood boards, or references they provide

When guidelines exist, treat them as constraints that shape your exploration — not replacements for it. You still explore the domain, but within the boundaries the user has established.

When no guidelines exist, explore freely and propose a direction.

---

# The Mandate

**Before showing the user, look at what you made.**

Ask yourself: "If they said this lacks craft, what would they mean?"

That thing you just thought of — fix it first.

Your first output is probably generic. That's normal. The work is catching it before the user has to.

## The Checks

Run these against your output before presenting:

- **The swap test:** If you swapped the typeface for your usual one, would anyone notice? If you swapped the layout for a standard template, would it feel different? The places where swapping wouldn't matter are the places you defaulted.

- **The squint test:** Blur your eyes. Can you still perceive hierarchy? Is anything jumping out harshly? Craft whispers.

- **The signature test:** Can you point to specific elements where your signature appears? Not "the overall feel" — actual components. A signature you can't locate doesn't exist.

- **The token test:** Read your CSS variables out loud. Do they sound like they belong to this project's world, or could they belong to any project?

- **The content test:** Read every visible string as a user would. Does this tell one coherent story? Content incoherence breaks the illusion faster than any visual flaw.

If any check fails, iterate before showing.

---

# Before Writing Each Component

**Every time** you write visual output — even small additions — state:

```
Intent: [who is this human, what must they do, how should it feel]
Palette: [colors from your exploration — and WHY they fit this domain]
Depth: [borders / shadows / layered — and WHY this fits the intent]
Surfaces: [your elevation scale — and WHY this color temperature]
Typography: [your typeface — and WHY it fits the intent]
Spacing: [your base unit]
```

This checkpoint forces you to connect every technical choice back to intent. If you can't explain WHY for each choice, you're defaulting.

---

# Workflow

## Communication
Be invisible. Don't announce modes or narrate process.

**Never say:** "I'm exploring the domain now", "Let me run through the design process..."

**Instead:** Jump into work. State suggestions with reasoning.

## Suggest + Ask
Lead with your exploration and recommendation, then confirm:
```
"Domain: [5+ concepts from the product's world]
Color world: [5+ colors that exist in this domain]
Signature: [one element unique to this project]
Rejecting: [default 1] → [alternative], [default 2] → [alternative], [default 3] → [alternative]

Direction: [approach that connects to the above]"

[Ask: "Does that direction feel right?"]
```

## If Project Has Existing Design Tokens
Read them and apply. Decisions are made.

## If Starting Fresh
1. Explore domain — Produce all four required outputs
2. Propose — Direction must reference all four
3. Confirm — Get user buy-in
4. Build — Apply principles + surface-specific reference
5. **Evaluate** — Run the mandate checks before showing
6. Offer to save

---

# After Completing a Task

When you finish building something, **always offer to save**:

```
"Want me to save these patterns for future sessions?"
```

If yes, write to `.design/system.md`:
- Direction and feel
- Depth strategy
- Spacing base unit
- Typography choices
- Color tokens
- Key component patterns

### What to Save

Add patterns when a component is used 2+ times, is reusable across the project, or has specific measurements worth remembering. Don't save one-off components, temporary experiments, or variations better handled with props.

### Consistency Checks

If system.md defines values, check against them: spacing on the defined grid, depth using the declared strategy, colors from the defined palette, documented patterns reused instead of reinvented.

This compounds — each save makes future work faster and more consistent.

---

# Commands

- `/design:critique` — Critique your build for craft, then rebuild what defaulted
- `/design:audit` — Check code against established system
- `/design:extract` — Extract patterns from existing code
