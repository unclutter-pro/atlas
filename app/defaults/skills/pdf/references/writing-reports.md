# Writing Reports

A report is a **multi-page hand-authored Typst document** based on the bundled scaffold (`templates/report.typ`). The CLI flags (`--title`, `--subtitle`, `--author`, `--date`, `--lang`, `--theme`) only control cover + header + footer metadata; the body content is YOUR responsibility.

## The expected workflow

```bash
# 1. Copy the scaffold into your working directory
cp /home/agent/projects/atlas/app/defaults/skills/pdf/templates/report.typ ./my-report.typ

# 2. Edit my-report.typ — keep the imports, page setup, cover, TOC; replace
#    the chapters at the bottom with your real content.

# 3. Iterate: typst watch auto-recompiles on save
typst watch --root / my-report.typ my-report.pdf

# 4. Final render via the wrapper (sets --root correctly):
build-pdf ./my-report.typ my-report.pdf
```

Treat the scaffold as a starter, not a template engine — every report is a custom Typst file.

## Chapter structure (recommended)

Reports work best with a predictable rhythm. The bundled scaffold uses this structure; copy it and adapt:

1. `= Zusammenfassung` — 3–5 bullet executive summary. Each point with a number + source.
2. `= [Topic background]` — what the reader needs to know to understand the rest. H2s for sub-sections.
3. `= Evidenzlage` — what the data says. Tables for structured comparisons, charts for trends.
4. `= [Implications / Recommendations]` — what to DO with this. Concrete, not hand-wavy.
5. `= Limitationen` — what this analysis CAN'T tell you. Builds trust.
6. `= Schlussfolgerungen` — one or two paragraphs that crystallise the takeaway.
7. `= Quellenverzeichnis` — flat list of sources, link-styled.

Don't slavishly follow this — fold/expand to fit the topic. But a report without an executive summary or a sources section reads amateur.

## Voice

- **Sober, not breathless.** Markt-Reports und Wissenschafts-Reports vertragen kein Empfehlungs-Feuerwerk. State findings, name confidence levels, let the reader decide.
- **Specific over general.** "30–40 % berichten Nutzen" beats "viele berichten Nutzen". Hard numbers earn trust.
- **Cite inline** with `#footnote[Quelle Jahr]` directly after the claim, not at the end of the paragraph. The reader's eye goes to the number, not the prose.
- **Show your sources matter** — name authors and journals where you can.

## Tables vs prose

Use a table when comparing 3+ items on the same dimensions (studies, products, companies, time periods). Use prose when explaining a mechanism or argument. Don't put narrative inside a table — split it.

```typst
#table(
  columns: (1.5fr, 1fr, 1.5fr),
  align: (left, center, left),
  table.header[Studie][Jahr][Ergebnis],
  [Brunstein et al.], [2019], [Moderate Verbesserung],
  [Reichel et al.],   [2021], [Kein signifikanter Effekt],
)
```

## Charts

Inline Cetz charts — never PNG screenshots — see [charts.md](charts.md). Rule of thumb: **a chart is worth it when the data tells a story the reader couldn't get from a sentence.** Don't chart 3 numbers; just write them.

Wrap every chart in `#figure(...)` with a caption that **states the question the chart answers**, not just what it shows:

```typst
#figure(
  cetz.canvas({ ... }),
  caption: [Wie wirken sich Koffein-Dosen auf Aufmerksamkeit aus? Moderate Dosen (50–100 mg) zeigen optimale Werte.],
)
```

## Localisation

`#l.report-toc` is auto-localised via i18n (de/en/fr) — but YOUR section headings and body text are not. Pick the lang for your audience and write the body in that language. Don't mix.

## Common pitfalls

- **`<` and `>` in content blocks** terminate Typst strings. Write `kleiner als 100` instead of `<100`. Inside content blocks `[...]` they're fine; inside string literals `"..."` they break.
- **Hyphenation on technical terms** — long words like `Neuroenhancement` get hyphen-broken inside narrow table cells. Either widen the cell (more `fr`) or wrap in `text(hyphenate: false)[...]`.
- **The report file MUST be readable from `--root`** — if you save it outside `--root=/`, the `build-pdf` wrapper won't find it. Easiest: save to your CWD and let `build-pdf` handle it.
- **TOC empties on first compile** — Typst needs two passes to populate the outline. `build-pdf` and `typst compile` handle this; just don't worry if a single `typst c` looks empty in some IDE plugins.

## Pre-flight before delivering

- [ ] Cover has author, date, subtitle that aren't placeholder
- [ ] TOC populated, page numbers correct
- [ ] Every chart has a caption that states the question
- [ ] Every claim with a number has a footnote citation
- [ ] No lorem ipsum, no `TODO`, no English headings in a German report
- [ ] PDF opens cleanly; file under ~3 MB for a 15-page report
