---
name: pdf
description: "Use this skill to CREATE / GENERATE / PRODUCE professional PDF documents from scratch — reports, invoices, business letters, memos, status updates, market analyses, proposals, anything where layout and visual quality matter. Triggers: 'erstelle PDF', 'baue Rechnung', 'mache einen Bericht als PDF', 'create a PDF', 'generate a report', 'render an invoice', 'business letter', 'Geschäftsbrief', 'Memo', plus any deliverable where the user expects a polished printable artifact. Primary engine: Typst (modern, fast, clean syntax). Charts via matplotlib (PNG) or Cetz (native Typst). Four ready-to-use templates bundled: report, invoice, letter, memo. Do NOT use for: (1) READING / EXTRACTING text from existing PDFs, OCR on scanned documents, parsing forms — use the `document-parse` skill (LiteParse). (2) Filling pre-existing fillable PDF forms — see `forms.md` reference. (3) Merging / splitting / rotating existing PDFs — see `reference.md` for qpdf / pypdf one-liners."
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Generation Skill

Produces professional, brand-consistent PDFs with **Typst** as the primary engine. Optimized for fast iteration: write `.typ` source, run one `build-pdf` command, get a polished PDF.

## When to use this skill

- **Reports** — market research, status reports, deliverables (template: `report`)
- **Invoices** — Rechnungen mit USt-konformer Struktur (template: `invoice`)
- **Letters** — DIN-5008 Geschäftsbriefe (template: `letter`)
- **Memos** — Single-page interne Notizen / Recaps (template: `memo`)
- **Custom PDFs** — own `.typ` source with full Typst flexibility

## When NOT to use this skill

- Reading or extracting text from existing PDFs → `document-parse` skill
- OCR on scanned documents → `document-parse` skill
- Filling existing PDF forms → see [forms.md](forms.md)
- Merging / splitting / rotating existing PDFs → see [reference.md](reference.md) for qpdf

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
- Image embedding via `image("charts/chart1.png", width: 90%)` with `figure(...)` captions
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

Two approaches, pick what fits:

### Option A — matplotlib PNGs (most flexible)

Pre-generate chart PNGs in a `charts/` subfolder next to the report and reference them:

```typst
#figure(
  image("charts/marktgroessen.png", width: 90%),
  caption: [Marktgrößen DACH 2024. Quelle: Bitkom.],
)
```

Default DPI 150, A4 width-friendly figure sizes ~10x5 inches.

### Option B — Cetz / cetz-plot (native Typst)

For brand-consistent vector charts compiled together with the document:

```typst
#import "@preview/cetz:0.4.2"
#import "@preview/cetz-plot:0.1.4"

#figure(
  cetz.canvas({
    import cetz.draw: *
    cetz-plot.plot.plot(size: (10, 5), {
      cetz-plot.plot.add-bar((("Tech", 225.9), ("Beratung", 48.7), ("Agenturen", 27.6)))
    })
  }),
  caption: [Marktgrößen DACH 2024 (Mrd. €).],
)
```

Cetz is slower to compile but stays as crisp vector at any zoom, and inherits the document fonts/colours.

## Fonts available in the container

Pre-installed by the Atlas Dockerfile:

| Family | Use |
|---|---|
| `Inter` | Body sans, UI, captions (modern, screen-friendly) |
| `IBM Plex Serif` | Body serif, headlines for reports/letters (business-appropriate) |
| `JetBrains Mono` | Monospace for code, numerals, technical content |
| `Crimson Pro` | Long-form serif (essays, op-eds) |
| `Liberation Sans/Serif/Mono` | Drop-in replacements for Arial/Times/Courier |
| `DejaVu Sans/Serif/Mono` | Broad Unicode coverage incl. Cyrillic, Greek, math symbols |
| `Noto Sans` + `Noto Sans CJK` | International scripts including Chinese, Japanese, Korean |

Use any of these in Typst as `#set text(font: "Inter")` etc. — no manual font loading needed.

## Pre-flight checklist

Before delivering a PDF:

- [ ] `typst compile` succeeds with no warnings (variable-font warnings are red flags)
- [ ] All `image(...)` paths resolve — open the PDF to confirm charts render
- [ ] Source citations consistent (URLs or footnotes, not mixed)
- [ ] Footer with date/version if the user will share externally
- [ ] PDF opens cleanly (`head -c 8 my.pdf` → `%PDF-1.7`)
- [ ] File size sane (< 3 MB for a 15-page report unless heavy images)

## Common pitfalls

1. **Variable fonts in Typst** — variable Inter/Plex builds throw `font fallback list must not be empty`. The Dockerfile installs static cuts.
2. **Curly quotes in template strings** — German `"…"` (U+201C/U+201D) terminate Typst strings since they're ASCII-identical to `"`. Use plain ASCII quotes inside strings.
3. **`#image("...")` path resolution** — relative to the `.typ` file. The `build-pdf` script sets `--root "$(pwd)"` so chart PNGs in your CWD work.
4. **Table overflows** — narrow your column headers or wrap with `text(size: 9pt)` for the table body.

## Useful one-liners

```bash
# Render and open immediately:
build-pdf memo --title "Stand $(date +%V)" /tmp/memo.pdf && xdg-open /tmp/memo.pdf

# Iterate on a custom template — auto-recompile on save:
typst watch my-report.typ my-report.pdf

# Combine multiple PDFs (see reference.md):
qpdf --empty --pages report.pdf invoice.pdf -- bundle.pdf
```

## Authoring custom templates

When the four bundled templates don't fit, write your own `.typ` from scratch. See [templates/AUTHORING.md](templates/AUTHORING.md) for a hands-on guide: the four Typst building blocks (`#set` / `#show` / `#let` / layout primitives), how to pull data via `--input` flags or JSON, theme reuse, plus a cookbook of recipes (two-column pages, right-aligned totals, repeating table headers, footnotes, auto-TOC, callouts, German money formatting). The "Common gotchas" section at the end (curly quotes, variable fonts, `context` for page-counter, image paths, ...) saves the first hour of frustration.

## See also

- [templates/AUTHORING.md](templates/AUTHORING.md) — write your own Typst templates from scratch.
- [reference.md](reference.md) — qpdf / pypdf one-liners for existing PDFs (merge, split, watermark, encrypt).
- [forms.md](forms.md) — filling existing PDF forms (kept for backwards compat).
- `templates/` — the four bundled Typst templates.
- `examples/` — sample JSON inputs for invoice and letter.
- `scripts/build-pdf` — wrapper around `typst compile`.
- `document-parse` skill — for the inverse direction (reading existing PDFs).
