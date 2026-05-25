# Writing Your Own Typst Templates

The practical guide for writing custom `.typ` files when the four bundled templates (report, invoice, letter, memo) don't fit. Assumes you've used `build-pdf` once and want to go beyond.

## 30-second mental model

Typst is "Markdown that compiles like LaTeX": you write content with light markup, and `#` lets you drop into a real expression language for layout, variables, and reusable functions. Everything is a value — content, text, numbers, tables, images.

A minimal template:

```typst
#set page(paper: "a4", margin: 2.5cm)
#set text(font: "Inter", size: 11pt)

= My Report
A first paragraph.

== A subsection
- Bullet point one
- Bullet point two
```

Compile:

```bash
build-pdf my-report.typ output.pdf
```

That's it. Add complexity from there.

## The four building blocks you'll touch every time

### 1. `#set` — apply a style to everything downstream
```typst
#set page(paper: "a4", margin: (top: 3cm, bottom: 3cm, x: 2.5cm))
#set text(font: "Inter", size: 11pt, lang: "de")
#set par(justify: true, leading: 0.7em)
```

### 2. `#show` — transform an element type wherever it appears
```typst
// Every H1 gets a page break + accent colour
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  set text(font: "IBM Plex Serif", size: 22pt, weight: "semibold", fill: rgb("#1E40AF"))
  it
}
```

### 3. `#let` — define a variable or function
```typst
#let title = sys.inputs.at("title", default: "Default Title")
#let fmt(n) = str(calc.round(n * 100) / 100)
```

### 4. `#figure(...)`, `#table(...)`, `#grid(...)` — the layout primitives
See cookbook below.

## Pulling data in from outside

Pick one. Most templates use one, some use both.

### Inputs via `--input` flags (best for short scalars)
```bash
build-pdf my.typ output.pdf --title "Q2 Recap" --author "Atlas"
```
In the template:
```typst
#let title = sys.inputs.at("title", default: "Untitled")
#let author = sys.inputs.at("author", default: "Anonymous")
```

### JSON via `--input data=...` (best for structured data)
```bash
build-pdf my.typ output.pdf --data path/to/data.json
```
In the template:
```typst
#let data = json(sys.inputs.at("data", default: "data.json"))
#data.title
#for item in data.items [ - #item.name (#item.qty) \ ]
```

### Reading a file directly (rarely needed, but possible)
```typst
#let prices = csv("prices.csv")
#let raw = read("notes.txt")
```

## Themes — reuse the colour system

All four bundled templates already do this. Copy the same import in any custom template:

```typst
#import "themes.typ": resolve-theme
#let theme = resolve-theme()
#let primary = theme.primary
#let accent  = theme.accent
#let muted   = theme.muted
#let rule    = theme.rule
```

Then `build-pdf my.typ --theme forest output.pdf` (or `--colors my-brand.json`) just works.

To know what's available: see `templates/themes.typ` (graphite default, indigo, forest, amber, crimson, mono).

## Cookbook — patterns you'll actually use

### Two-column page (sidebar + main body)
```typst
#grid(
  columns: (1fr, 2fr),
  gutter: 1.5em,
  [
    *Sidebar*
    - Quick fact 1
    - Quick fact 2
  ],
  [
    Main body content here. Lorem ipsum.
  ],
)
```

### Right-aligned label/value list (e.g. totals)
```typst
#table(
  columns: (1fr, auto),
  align: (right, right),
  stroke: none,
  inset: (x: 0pt, y: 4pt),
  column-gutter: 2em,
  [Subtotal], [€ 3.680,00],
  [VAT 19%], [€ 699,20],
  [*Total*], [*€ 4.379,20*],
)
```

### Table that repeats its header on page breaks
```typst
#table(
  columns: (auto, 1fr, auto),
  table.header[Pos.][Beschreibung][Betrag],
  ..items.enumerate().map(((i, it)) => (str(i + 1), it.name, it.amount)).flatten(),
)
```
`table.header(...)` wraps the header row — Typst repeats it on every spilled page.

### Block that must NOT split across pages (e.g. signature)
```typst
#block(breakable: false)[
  ... block content ...
]
```

### Footnotes
```typst
ITK wuchs 2024 um 4,7 %#footnote[Bitkom Marktdaten, Stand März 2025.].
```

### Chart with caption (Cetz vector — the one chart story)
```typst
#import "@preview/cetz:0.4.2"
#import "@preview/cetz-plot:0.1.3": chart

#figure(
  cetz.canvas({
    chart.barchart(
      mode: "basic",
      size: (10, 4),
      label-key: 0, value-key: 1,
      bar-style: i => (fill: accent),
      (("Tech", 225.9), ("Beratung", 48.7), ("Agenturen", 27.6)),
    )
  }),
  caption: [Marktgrößen DACH 2024 (Mrd. €). Quelle: Bitkom.],
)
```
Patterns per chart type in [references/charts.md](../references/charts.md).

### Image with caption (logos, photos, screenshots)
```typst
#figure(
  image("photos/team.png", width: 90%),
  caption: [Teamfoto Q2 2026.],
)
```
Path is relative to the `.typ` file. The `build-pdf` script sets `--root "$(pwd)"` so files in the current working directory resolve.

### Headers + footers with page numbers
```typst
#set page(
  header: align(right)[
    #text(size: 9pt, fill: gray)[My Document]
  ],
  footer: context align(center)[
    #text(size: 9pt, fill: gray)[
      Seite #counter(page).display() / #counter(page).final().last()
    ]
  ],
)
```
The `context` keyword is REQUIRED if you call `counter(page).final()` — without it, Typst won't know the final page count yet.

### Auto-generated Table of Contents
```typst
#outline(
  title: [Inhalt],
  target: heading.where(level: 1).or(heading.where(level: 2)),
  indent: auto,
  depth: 2,
)
```
With dot-leaders and right-aligned page numbers:
```typst
#show outline.entry: it => link(it.element.location(),
  it.indented(it.prefix(), {
    it.body()
    box(width: 1fr, repeat[#h(0.3em).#h(0.3em)])
    it.page()
  }))
#outline(target: heading.where(level: 1).or(heading.where(level: 2)))
```

### Cover page that skips header/footer
```typst
#page(header: none, footer: none, margin: (top: 6cm, x: 3cm))[
  #text(size: 36pt, weight: "bold")[My Document]
  #v(0.5em)
  #text(size: 18pt, fill: gray)[A subtitle here]
]
#pagebreak()
```

### Coloured panel / callout
```typst
#block(
  width: 100%,
  fill: rgb("#FEF3C7"),
  inset: 12pt,
  radius: 4pt,
  breakable: false,
)[
  *Hinweis:* Dies ist ein Callout in Amber.
]
```

### German money formatter (comma decimal, no thousands separator yet)
```typst
#let eur(n) = {
  let s = str(calc.round(n * 100) / 100)
  if not s.contains(".") { s = s + ".00" }
  let parts = s.split(".")
  let cents = if parts.at(1).len() == 1 { parts.at(1) + "0" } else { parts.at(1) }
  parts.at(0) + "," + cents + " €"
}
```

### Conditional sections via `#if` and the array spread `..`
```typst
#let items = (
  ([Section A], "always shows"),
  ([Section B], "always shows"),
)
#table(
  columns: 2,
  ..items.map(((a, b)) => (a, [#b])).flatten(),
  ..(if show_extra { ([Extra], [Bonus row]) } else { () }),
)
```

## Common gotchas

1. **Curly quotes "…" terminate strings**. German typographic quotes `"…"` (U+201C/U+201D) are ASCII-identical to `"` to Typst's lexer. Inside string literals use plain `"`, inside content blocks (`[…]`) anything goes.

2. **Variable fonts cause warnings**. The container ships *static* font cuts: Inter, IBM Plex Serif, JetBrains Mono, Crimson Pro. Don't reference `Inter Variable` or `Inter Tight VF`.

3. **`counter(page).final()` needs `context`**. Wrap the surrounding expression in `context { ... }` or `context align(...)[...]` — otherwise Typst evaluates it during the first pass before the page count exists.

4. **Image paths are relative to the `.typ` file**, not the working directory. Use `image("photos/x.png")` and put external images next to the template. The `build-pdf` script sets `--root /` so absolute paths work too.

5. **Tables with `columns: (1fr, auto)`**: 1fr stretches to fill, auto is content-width. Use this for two-column layouts where you want labels on the left squeezed against amounts on the right.

6. **`pagebreak(weak: true)`** only breaks if there's actually content above on the page. Good for "start chapter on a new page if possible".

7. **`table.header(...)` vs first row**: explicitly wrap the header in `table.header(...)` so it repeats on every spilled page. A normal first row will NOT repeat.

8. **`inset: 0pt` removes padding entirely**. Use `inset: (x: 0pt, y: 4pt)` to keep vertical breathing room while flushing columns to the gutter.

## Quick reference — what to read when

| You want to ... | Look at |
|---|---|
| Style every H1 / H2 / H3 | `show heading.where(level: N)` in any of our four templates |
| Build a JSON-driven invoice | `templates/invoice.typ` |
| Build a multi-page report with TOC | `templates/report.typ` |
| Add a chart | `references/charts.md` (Cetz patterns) + `templates/report.typ` Wettbewerbslandschaft block |
| Brand the document with own colours | `templates/themes.typ` + `--theme` or `--colors` |
| Add ZUGFeRD / Factur-X for invoices | `scripts/invoice-zugferd` |
| Look up a Typst function | The Typst docs at <https://typst.app/docs/reference> are excellent and searchable |

## When to stop and ask

If you're spending more than 30 minutes fighting Typst layout for a one-off document — that's a sign the document doesn't fit the Typst sweet spot. Alternatives:

- Heavy multi-column magazine layout → use a dedicated DTP tool (Affinity Publisher, InDesign)
- Filling existing PDF forms → see [../references/forms.md](../references/forms.md)
- Single landing-page-style poster → use the `design` or `frontend-design` skill (HTML + Chromium → PDF)

Otherwise stay in Typst — it pays back in iteration speed.
