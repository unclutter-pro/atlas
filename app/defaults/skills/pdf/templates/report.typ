// report.typ — multi-page research / status / market report template.
//
// Usage:
//   build-pdf report --title "..." --subtitle "..." --author "..." [--theme indigo|forest|amber|crimson|mono] output.pdf

#import "themes.typ": resolve-theme
#import "i18n.typ": t, format-date
#import "@preview/cetz:0.4.2"
#import "@preview/cetz-plot:0.1.3": chart

#let title = sys.inputs.at("title", default: "Report")
#let subtitle = sys.inputs.at("subtitle", default: "")
#let author = sys.inputs.at("author", default: "Atlas")
#let lang = sys.inputs.at("lang", default: "de")
#let l = t(lang)

// Date: ISO YYYY-MM-DD preferred (gets locale-formatted), any other string passes through.
#let date-raw = sys.inputs.at("date", default: datetime.today().display("[year]-[month]-[day]"))
#let date = format-date(date-raw, lang: lang)

#let theme = resolve-theme()
#let primary      = theme.primary
#let accent       = theme.accent
#let muted        = theme.muted
#let rule         = theme.rule
#let background   = theme.background
#let surface      = theme.surface
#let font-body    = theme.font-body
#let font-heading = theme.font-heading

// --- Page setup -----------------------------------------------------------
#set page(
  paper: "a4",
  margin: (top: 2.8cm, bottom: 2.8cm, x: 2.5cm),
  fill: background,
  header: align(right)[
    #text(size: 9pt, fill: muted)[#title]
  ],
  footer: context align(center)[
    #text(size: 9pt, fill: muted)[
      #l.page #counter(page).display() / #counter(page).final().last()
      · #date
    ]
  ],
)
#set text(font: font-body, size: 11pt, fill: primary, lang: lang)
#set par(justify: true, leading: 0.7em, spacing: 1em)

// H1: page break + serif title in primary; accent shows up as a single short
// rule below the title, never as the title's fill. H2/H3 stay neutral.
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  set text(font: font-heading, size: 28pt, weight: "semibold", fill: primary)
  v(0.5em)
  it
  v(0.2em)
  line(length: 2.5em, stroke: 2pt + accent)
  v(1.2em)
}
#show heading.where(level: 2): it => {
  v(0.6em)
  set text(font: font-body, size: 13pt, weight: "semibold", fill: primary)
  it
  v(0.1em)
}
#show heading.where(level: 3): set text(font: font-body, size: 11pt, weight: "medium", fill: muted)

#show table.cell.where(y: 0): set text(weight: "semibold", fill: accent)
#set table(stroke: 0.5pt + rule, inset: 9pt)

// --- Cover ---------------------------------------------------------------
// One restrained accent splash: a short eyebrow rule + a small caps label.
// The title itself is primary; the typography carries the impact.
#page(header: none, footer: none, margin: (top: 7cm, bottom: 4cm, x: 3.5cm))[
  #line(length: 2.5em, stroke: 2pt + accent)
  #v(0.4em)
  #text(size: 9pt, tracking: 0.2em, weight: "semibold", fill: accent)[#upper(l.report-by + " " + author)]
  #v(2.5em)
  // Tight leading on the cover title — at 42pt the default 0.65em leaves too
  // much air between wrapped lines; 0.5em reads as one heading block.
  #par(leading: 0.5em)[
    #text(font: font-heading, size: 42pt, weight: "semibold", fill: primary)[#title]
  ]
  #v(0.8em)
  #text(font: font-body, size: 16pt, fill: muted)[#subtitle]
  #v(4em)
  #text(font: font-body, size: 10pt, fill: muted)[#date]
]

// --- Table of Contents ----------------------------------------------------
// Print the TOC on its own page, no header/footer, with dot-leader fills
// connecting heading title and page number. Auto-populates from H1/H2.
#page(header: none, footer: none, margin: (top: 3cm, bottom: 3cm, x: 3.5cm))[
  #text(font: font-heading, size: 24pt, weight: "semibold", fill: primary)[#l.report-toc]
  #v(0.3em)
  #line(length: 1.5em, stroke: 1.5pt + accent)
  #v(1.2em)
  #show outline.entry: it => link(
    it.element.location(),
    it.indented(it.prefix(), {
      // body title with dot leader to the page number
      it.body()
      box(width: 1fr, repeat[#h(0.3em).#h(0.3em)])
      it.page()
    }),
  )
  #outline(
    title: none,
    target: heading.where(level: 1).or(heading.where(level: 2)),
    indent: auto,
    depth: 2,
  )
]

// --- Executive Summary ----------------------------------------------------
= Executive Summary

Hier kommt eine 3–5-bullet Zusammenfassung. Jede Aussage mit Quellen-Link.

- *Fakt 1* mit Zahl + Quelle.
- *Fakt 2* mit Zahl + Quelle.
- *Fakt 3* mit Zahl + Quelle.

// --- Body chapters --------------------------------------------------------
= Marktdefinition

== Sub-Segment A

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
incididunt ut labore et dolore magna aliqua.

== Sub-Segment B

#table(
  columns: (1fr, auto, auto),
  align: (left, right, right),
  table.header[Segment][Volumen (Mrd. €)][Wachstum %],
  [Tech], [225,9], [+4,7],
  [Beratung], [48,7], [+4,3],
  [Werbeagenturen], [27,6], [−0,9],
)

= Wettbewerbslandschaft

Charts werden direkt mit Cetz / cetz-plot gerendert — Vektor, fontkonsistent, themefarbig:

#figure(
  cetz.canvas({
    chart.barchart(
      mode: "basic",
      size: (10, 4),
      label-key: 0,
      value-key: 1,
      bar-style: i => (fill: accent),
      x-tick-step: 50,
      (
        ("Tech",          225.9),
        ("Beratung",       48.7),
        ("Werbeagenturen", 27.6),
        ("WP + StB",       21.3),
      ),
    )
  }),
  caption: [Marktgrößen-Vergleich DACH 2024 (Mrd. €). Quelle: Verbandsdaten.],
)

= Trends & Treiber

Fließtext mit Footnote-Quellen-Stil: ITK wuchs 2024 um 4,7 %#footnote[Bitkom Marktdaten, Stand März 2025.].

= Methodik-Hinweise

Welche Quellen sicher / unsicher / Schätzung. Limits klar benennen.

= Bibliografie

- Quelle 1 — #link("https://example.com")[Beispiel-URL]
- Quelle 2 — #link("https://example.com")[Beispiel-URL]
