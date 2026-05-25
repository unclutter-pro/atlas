// report.typ — multi-page research / status / market report template.
//
// Usage:
//   build-pdf report --title "..." --subtitle "..." --author "..." [--theme indigo|forest|amber|crimson|mono] output.pdf

#import "themes.typ": resolve-theme

#let title = sys.inputs.at("title", default: "Report-Titel")
#let subtitle = sys.inputs.at("subtitle", default: "Untertitel mit Kontext")
#let author = sys.inputs.at("author", default: "Atlas")
#let date = sys.inputs.at("date", default: datetime.today().display())

#let theme = resolve-theme()
#let primary = theme.primary
#let accent  = theme.accent
#let muted   = theme.muted
#let rule    = theme.rule

// --- Page setup -----------------------------------------------------------
#set page(
  paper: "a4",
  margin: (top: 2.8cm, bottom: 2.8cm, x: 2.5cm),
  header: align(right)[
    #text(size: 9pt, fill: muted)[#title]
  ],
  footer: context align(center)[
    #text(size: 9pt, fill: muted)[
      Seite #counter(page).display() / #counter(page).final().last()
      · #date
    ]
  ],
)
#set text(font: "Inter", size: 11pt, fill: primary, lang: "de")
#set par(justify: true, leading: 0.7em, spacing: 1em)

#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  set text(font: "IBM Plex Serif", size: 22pt, weight: "semibold", fill: accent)
  v(0.5em)
  it
  v(0.8em)
}
#show heading.where(level: 2): it => {
  v(0.6em)
  set text(font: "Inter", size: 14pt, weight: "semibold")
  it
  v(0.2em)
}
#show heading.where(level: 3): set text(font: "Inter", size: 12pt, weight: "medium")

#show table.cell.where(y: 0): set text(weight: "semibold", fill: accent)
#set table(stroke: 0.5pt + rule, inset: 9pt)

// --- Cover ---------------------------------------------------------------
#page(header: none, footer: none, margin: (top: 7cm, bottom: 4cm, x: 3.5cm))[
  #text(font: "IBM Plex Serif", size: 38pt, weight: "semibold", fill: accent)[#title]
  #v(0.8em)
  #text(font: "Inter", size: 16pt, fill: muted)[#subtitle]
  #v(3.5em)
  #text(font: "Inter", size: 11pt, fill: muted)[
    #author · #date
  ]
]

// --- Table of Contents ----------------------------------------------------
// Print the TOC on its own page, no header/footer, with dot-leader fills
// connecting heading title and page number. Auto-populates from H1/H2.
#page(header: none, footer: none, margin: (top: 3cm, bottom: 3cm, x: 3.5cm))[
  #text(font: "IBM Plex Serif", size: 24pt, weight: "semibold", fill: accent)[Inhalt]
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

Hier kommen Charts. Verweise auf Chart-PNGs in `charts/`:

#figure(
  image("charts/chart1.png", width: 90%),
  caption: [Marktgrößen-Vergleich DACH 2024 (Mrd. €). Quelle: Verbandsdaten.],
)

= Trends & Treiber

Fließtext mit Footnote-Quellen-Stil: ITK wuchs 2024 um 4,7 %#footnote[Bitkom Marktdaten, Stand März 2025.].

= Methodik-Hinweise

Welche Quellen sicher / unsicher / Schätzung. Limits klar benennen.

= Bibliografie

- Quelle 1 — #link("https://example.com")[Beispiel-URL]
- Quelle 2 — #link("https://example.com")[Beispiel-URL]
