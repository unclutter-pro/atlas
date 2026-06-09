---
name: pdf
description: "Use this skill for any PDF authoring or post-processing task that doesn't require READING the content. CREATE / GENERATE / PRODUCE PDFs from scratch — reports, invoices, business letters, memos, status updates, market analyses, proposals (Typst engine, charts via Cetz, four bundled templates: report, invoice, letter, memo). FILL existing PDF forms — text fields, checkboxes, radio buttons. MERGE / SPLIT / ROTATE / WATERMARK / ENCRYPT existing PDFs via qpdf and pypdf. Embed ZUGFeRD / Factur-X XML for EU e-invoices. Triggers: 'erstelle PDF', 'baue Rechnung', 'mache einen Bericht als PDF', 'create a PDF', 'generate a report', 'render an invoice', 'business letter', 'Geschäftsbrief', 'Memo', 'merge PDFs', 'split a PDF', 'rotate pages', 'watermark this PDF', 'encrypt PDF', 'PDF Formular ausfüllen', 'fill this form'. Do NOT use for READING / EXTRACTING text from existing PDFs or OCR on scanned documents — use the `document-parse` skill (LiteParse)."
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

### Form-filling decision tree

1. `python scripts/check_fillable_fields.py <file.pdf>` — does the PDF have AcroForm fields?
2. **Has fillable fields** → `scripts/extract_form_field_info.py` to inspect, then `scripts/fill_fillable_fields.py` to fill.
3. **No fillable fields** (flat scan or rendered form) → fall back to the visual estimation path in [references/forms.md](references/forms.md).

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
| `--date` | Header date (ISO `YYYY-MM-DD` → locale-formatted; default: today) |
| `--lang` | `de` (default) / `en` / `fr` — affects labels (Inhalt/Contents/Sommaire, Seite/Page) and date format |

**Note**: The bundled `report.typ` is a *starter scaffold* with placeholder German chapter headings and lorem-ipsum body text. The `--key` flags only control cover/header metadata — actual content (sections, charts, tables) must be added by copying `templates/report.typ` and editing it. For voice, structure, chart usage, and pre-flight checklist see [references/writing-reports.md](references/writing-reports.md). For pure metadata-driven output (no edits needed), use `memo` or `letter` instead.

### `invoice` — DIN-A4 Rechnung

- Sender block top-left + invoice metadata grid
- Recipient block on the left, metadata (Rechnungs-Nr, Datum, Fällig) on the right
- Line items table with running sums
- Totals block: Subtotal · USt-% · Total
- IBAN / BIC / USt-IdNr footer block
- Optional `notes` line
- Invoice number auto-scales (28pt → 20pt → 14pt) so DATEV-style long numbers stay readable
- Dates accept ISO `YYYY-MM-DD` (locale-formatted) or pre-formatted free-form strings; service date can be a range like `"2026-05-15 — 2026-05-23"`
- Numbers locale-formatted: DE `1.600,00` · EN `1,600.00` · FR `1 600,00`

Inputs: `--data path/to/invoice.json` (see `examples/invoice-sample.json` for shape). Add `"lang": "en"` (or `"fr"`, default `"de"`) to switch labels and date/number format.

### `letter` — DIN-5008 Geschäftsbrief

- Sender mini-address top-right
- Underlined Rücksendezeile (DIN 5008)
- Recipient in the postal-window area
- Right-aligned date + bold subject
- Body with multi-paragraph support (separate paragraphs by `\n\n` in JSON)
- Salutation, body, closing, signature in correct German business style

Inputs: `--data path/to/letter.json` (see `examples/letter-sample.json`). Add `"lang": "en"` (or `"fr"`) to switch the subject label and date format — note: DIN-5008 letters often pre-format the date with a city prefix ("Stuttgart, 25. Mai 2026"), which passes through unchanged.

### `memo` — single-page recap

- Slim header bar with title (auto-shrinks 20pt → 17pt → 14pt for long titles), To, From, Date
- Three default sections: *Was passiert ist* · *Entscheidungen* · *Nächste Schritte*
- Compact table for owner / task / deadline
- **Single-page discipline**: if your content overflows to page 2, you wrote a report — see [references/writing-memos.md](references/writing-memos.md)

Inputs: `--title`, `--to`, `--from`, `--date` (ISO `YYYY-MM-DD` → locale-formatted), `--lang` (`de` / `en` / `fr`).

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

## Languages

All four templates support **`de`** (default) / **`en`** / **`fr`** via the `lang` input.

| Aspect | `de` | `en` | `fr` |
|---|---|---|---|
| Labels | Rechnung, Fällig bis, ... | Invoice, Due by, ... | Facture, Échéance, ... |
| Date format | `25.05.2026` | `2026-05-25` (ISO) | `25/05/2026` |
| Number format | `1.600,00` | `1,600.00` | `1 600,00` (NBSP) |

Set via `--lang en` for memo/report (CLI flag), or `"lang": "en"` in the invoice/letter JSON.

Add another language by extending `templates/i18n.typ` — drop a new entry into the `labels` dict and add date/number format branches.

## Fonts and themes

Six built-in themes (`graphite` default, `indigo`, `forest`, `amber`, `crimson`, `mono`) selectable via `--theme <name>`. Each theme bundles **colours, fonts AND backgrounds** — nine design tokens:

- Colours: `primary`, `accent`, `muted`, `rule`, `background`, `surface`
- Fonts: `font-body`, `font-heading`, `font-mono`

So picking `--theme amber` gives you cream page background + Crimson Pro headlines; `--theme mono` is all-monospace; `--theme indigo` keeps Inter + IBM Plex Serif but with indigo accents and a tinted surface.

Per-brand override via `--colors brand.json` accepts any subset of the nine tokens. Container ships with Inter, IBM Plex Serif, JetBrains Mono, Crimson Pro, Liberation, DejaVu, Noto + CJK.

Full theme list, token explanations, brand-override JSON shape in [references/themes-and-fonts.md](references/themes-and-fonts.md).

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
- [ ] For Factur-X invoices: `facturx-xmlcheck out.pdf` passes (schema + schematron)

## Common pitfalls

1. **Curly quotes "…" terminate Typst strings** — German typographic quotes (U+201C/U+201D) are ASCII-identical to `"`. Inside string literals use plain `"`; inside content blocks (`[…]`) anything goes.
2. **Variable fonts** — reference `"Inter"`, not `"Inter Variable"`. The container ships static cuts only.
3. **Table overflows** — narrow column headers or wrap the body with `text(size: 9pt)`.
4. **Unescaped `#` in content** — a bare `#` switches Typst into code mode (`error: the character # is not valid in code`). Write `\#` for a literal. Same for literal `$ _ * @`.

When a compile fails, `build-pdf` prints Typst's diagnostic **plus** a targeted hint for these two recurring errors (`#`-escaping and unclosed delimiters) and a pointer to [references/typst-cheatsheet.md](references/typst-cheatsheet.md). Read the cheatsheet before re-running — don't re-compile blindly.

For Typst-authoring gotchas (image paths, `context` for `counter(page).final()`, `table.header(...)` repeat, `pagebreak(weak: true)`) see [templates/custom-templates.md § Common gotchas](templates/custom-templates.md).

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
    ├── writing-reports.md            How to write a good report — workflow, structure, voice, pitfalls
    ├── writing-memos.md              How to keep memos single-page and operational
    ├── typst-cheatsheet.md           Escape rules, common patterns, theme tokens
    ├── charts.md                     Cetz / cetz-plot chart patterns and anti-patterns
    ├── themes-and-fonts.md           6 built-in themes, font swap recipes, brand override
    ├── zugferd.md                    Factur-X profile choices, EN 16931 mapping, recipient compatibility
    ├── existing-pdfs.md              Merge, split, rotate, watermark, encrypt existing PDFs
    └── forms.md                      Filling existing PDF forms (radio, checkbox, text fields)
```

## Companion skills

- `document-parse` — reading PDFs (OCR, text extraction).
