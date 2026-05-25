---
name: pdf
description: "Use this skill for any PDF authoring or post-processing task that doesn't require READING the content. CREATE / GENERATE / PRODUCE PDFs from scratch — reports, invoices, business letters, memos, status updates, market analyses, proposals (Typst engine, charts via Cetz, four bundled templates: report, invoice, letter, memo). FILL existing PDF forms — text fields, checkboxes, radio buttons (see references/forms.md). MERGE / SPLIT / ROTATE / WATERMARK / ENCRYPT existing PDFs via qpdf and pypdf (see references/existing-pdfs.md). Embed ZUGFeRD / Factur-X XML for EU e-invoices (see references/zugferd.md). Triggers: 'erstelle PDF', 'baue Rechnung', 'mache einen Bericht als PDF', 'create a PDF', 'generate a report', 'render an invoice', 'business letter', 'Geschäftsbrief', 'Memo', 'merge PDFs', 'split a PDF', 'rotate pages', 'watermark this PDF', 'encrypt PDF', 'PDF Formular ausfüllen', 'fill this form'. Do NOT use for READING / EXTRACTING text from existing PDFs or OCR on scanned documents — use the `document-parse` skill (LiteParse)."
---

# PDF Generation Skill

Produces professional, brand-consistent PDFs with **Typst** as the primary engine. Optimized for fast iteration: write `.typ` source, run one `build-pdf` command, get a polished PDF.

## When to use this skill

**Create new PDFs from scratch:**
- **Reports** — market research, status reports, deliverables (template: `report`)
- **Invoices** — Rechnungen mit USt-konformer Struktur (template: `invoice`)
- **Letters** — DIN-5008 Geschäftsbriefe (template: `letter`)
- **Memos** — Single-page interne Notizen / Recaps (template: `memo`)
- **Custom PDFs** — own `.typ` source with full Typst flexibility

**Work with existing PDFs:**
- **Fill PDF forms** — text fields, checkboxes, radio buttons → [references/forms.md](references/forms.md)
- **Merge, split, rotate** — combine, extract page ranges, rotate pages → [references/existing-pdfs.md](references/existing-pdfs.md)
- **Watermark, encrypt, repair** — qpdf and pypdf one-liners → [references/existing-pdfs.md](references/existing-pdfs.md)

## When NOT to use this skill

- Reading or extracting text from existing PDFs → `document-parse` skill
- OCR on scanned documents → `document-parse` skill

## Quick start

```bash
# Pick a template and pipe in your data:
build-pdf report \
  --title "Markt-Recherche DACH" \
  --subtitle "Tech / Beratung / Agentur" \
  --author "Atlas" \
  output/report.pdf

build-pdf invoice --data examples/invoice-sample.json output/invoice.pdf

build-pdf letter  --data my-letter.json              output/letter.pdf

build-pdf memo \
  --title "Sprint Recap KW 22" \
  --to "Team" \
  --from "Max" \
  output/memo.pdf

# Custom template? Just pass the .typ path:
build-pdf path/to/custom.typ output/custom.pdf
```

The `build-pdf` script lives in `scripts/build-pdf` of this skill.

## The four bundled templates

### `report` — multi-page research / status / market reports

- Cover page with title + subtitle + author + date
- Auto headers/footers + page numbers
- H1 forces a page break, H2/H3 inline
- Tables with brand-coloured headers and subtle row rules
- Native Cetz vector charts (`cetz.canvas { chart.barchart(...) }`) inside `figure(...)` with captions
- Footnote-style source citations: `text#footnote[Bitkom, 2024]`

Inputs (all optional, sensible defaults):

| `--key` | Purpose |
|---|---|
| `--title` | Cover title |
| `--subtitle` | Cover subtitle |
| `--author` | Cover footer |
| `--date` | Header date (default: today) |

### `invoice` — DIN-A4 Rechnung

- Sender block top-left + invoice metadata grid
- Recipient block on the left, metadata (Rechnungs-Nr, Datum, Fällig) on the right
- Line items table with running sums
- Totals block: Subtotal · USt-% · Total
- IBAN / BIC / USt-IdNr footer block
- Optional `notes` line

Inputs: `--data path/to/invoice.json` (see `examples/invoice-sample.json` for shape).

### `letter` — DIN-5008 Geschäftsbrief

- Sender mini-address top-right
- Underlined Rücksendezeile (DIN 5008)
- Recipient in the postal-window area
- Right-aligned date + bold subject
- Body with multi-paragraph support (separate paragraphs by `\n\n` in JSON)
- Salutation, body, closing, signature in correct German business style

Inputs: `--data path/to/letter.json` (see `examples/letter-sample.json`).

### `memo` — single-page recap

- Slim header bar with title, To, From, Date
- Three default sections: *Was passiert ist* · *Entscheidungen* · *Nächste Schritte*
- Compact table for owner / task / deadline

Inputs: `--title`, `--to`, `--from`, `--date`.

## Charts and figures

Draw charts with **Cetz + cetz-plot** — native to Typst, vector all the way, inherits the document's theme:

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
  caption: [Marktgrößen DACH 2024 (Mrd. €).],
)
```

Patterns per chart type (horizontal bar, vertical bar, line, stacked, diverging), theme integration, anti-patterns in [references/charts.md](references/charts.md).

## Fonts and themes

Six built-in themes (`graphite` default, `indigo`, `forest`, `amber`, `crimson`, `mono`) selectable via `--theme <name>`. Per-brand colour overrides via `--colors brand.json`. Container ships with Inter, IBM Plex Serif, JetBrains Mono, Crimson Pro, Liberation, DejaVu, Noto + CJK — usable directly as `#set text(font: "Inter")`.

Full theme list, font swap recipes, brand-override JSON shape in [references/themes-and-fonts.md](references/themes-and-fonts.md).

## E-Invoices (ZUGFeRD / Factur-X)

For German B2B and EU public-sector invoices, the `invoice` template pairs with the `scripts/invoice-zugferd` helper to embed a CII XML (EN 16931 profile):

```bash
build-pdf invoice --data invoice.json invoice.pdf
invoice-zugferd invoice.pdf invoice.json invoice_factur-x.pdf
```

Profile choices, recipient compatibility, current limitations (multiple VAT rates, Skonto, reverse charge), and validation commands in [references/zugferd.md](references/zugferd.md).

## Pre-flight checklist

Before delivering a PDF:

- [ ] `typst compile` succeeds with no warnings (variable-font warnings are red flags)
- [ ] All charts render and external image paths resolve — open the PDF to confirm
- [ ] Source citations consistent (URLs or footnotes, not mixed)
- [ ] Footer with date/version if the user will share externally
- [ ] PDF opens cleanly (`head -c 8 my.pdf` → `%PDF-1.7`)
- [ ] File size sane (< 3 MB for a 15-page report unless heavy images)

## Common pitfalls

1. **Variable fonts in Typst** — variable Inter/Plex builds throw `font fallback list must not be empty`. Use the static cuts installed in the container.
2. **Curly quotes in template strings** — German `"…"` (U+201C/U+201D) terminate Typst strings since they're ASCII-identical to `"`. Use plain ASCII quotes inside strings.
3. **`#image("...")` path resolution** — relative to the `.typ` file. The `build-pdf` script sets `--root "$(pwd)"` so external PNGs in your CWD work.
4. **Table overflows** — narrow your column headers or wrap with `text(size: 9pt)` for the table body.

## Useful one-liners

```bash
# Render and open immediately:
build-pdf memo --title "Stand $(date +%V)" /tmp/memo.pdf && xdg-open /tmp/memo.pdf

# Iterate on a custom template — auto-recompile on save:
typst watch my-report.typ my-report.pdf

# Combine multiple PDFs (see references/existing-pdfs.md):
qpdf --empty --pages report.pdf invoice.pdf -- bundle.pdf
```

## Writing your own templates

When the four bundled templates don't fit, write your own `.typ` from scratch. See [templates/custom-templates.md](templates/custom-templates.md) for a hands-on guide: the four Typst building blocks (`#set` / `#show` / `#let` / layout primitives), how to pull data via `--input` flags or JSON, theme reuse, plus a cookbook of recipes (two-column pages, right-aligned totals, repeating table headers, footnotes, auto-TOC, callouts, German money formatting). The "Common gotchas" section at the end (curly quotes, variable fonts, `context` for page-counter, image paths, ...) saves the first hour of frustration.

## File layout

```
pdf/
├── SKILL.md                          ← you are here
├── templates/
│   ├── custom-templates.md           Guide for writing your own Typst templates
│   ├── themes.typ                    Theme palette definitions
│   └── report.typ  invoice.typ  letter.typ  memo.typ
├── examples/
│   ├── invoice-sample.json
│   └── letter-sample.json
├── scripts/
│   ├── build-pdf                     One-command typst compile wrapper
│   ├── invoice-zugferd               Embeds Factur-X XML into rendered invoice
│   └── *.py                          PDF form-filling helpers (see references/forms.md)
└── references/
    ├── charts.md                     Cetz / cetz-plot chart patterns and anti-patterns
    ├── themes-and-fonts.md           6 built-in themes, font swap recipes, brand override
    ├── zugferd.md                    Factur-X profile choices, EN 16931 mapping, recipient compatibility
    ├── existing-pdfs.md              Merge, split, rotate, watermark, encrypt existing PDFs
    └── forms.md                      Filling existing PDF forms (radio, checkbox, text fields)
```

## See also

- [templates/custom-templates.md](templates/custom-templates.md) — write your own Typst templates from scratch.
- [references/charts.md](references/charts.md) — chart cookbook (Cetz / cetz-plot).
- [references/themes-and-fonts.md](references/themes-and-fonts.md) — theming + typography.
- [references/zugferd.md](references/zugferd.md) — Factur-X / EN 16931 e-invoices.
- [references/existing-pdfs.md](references/existing-pdfs.md) — merge / split / rotate / watermark / encrypt existing PDFs.
- [references/forms.md](references/forms.md) — filling existing PDF forms.
- `document-parse` skill — reading PDFs (OCR, text extraction).
