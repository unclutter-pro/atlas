// report.typ — multi-page research / status / market report template.
//
// Usage:
//   typst compile --input title="..." --input subtitle="..." --input author="..." report.typ output.pdf
//
// Replace the placeholder content below with your actual report body.

#let title = sys.inputs.at("title", default: "Report-Titel")
#let subtitle = sys.inputs.at("subtitle", default: "Untertitel mit Kontext")
#let author = sys.inputs.at("author", default: "Atlas")
#let date = sys.inputs.at("date", default: datetime.today().display())

// --- Brand tokens (override via your own .typ file) -----------------------
#let primary = rgb("#1F2937")        // ink
#let accent  = rgb("#2563EB")        // headline accent
#let muted   = rgb("#6B7280")        // captions, footer
#let rule    = rgb("#E5E7EB")        // table borders

// --- Page setup -----------------------------------------------------------
#set page(
  paper: "a4",
  margin: (top: 2.5cm, bottom: 2.5cm, x: 2.2cm),
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
#set par(justify: true, leading: 0.65em)

#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  set text(font: "IBM Plex Serif", size: 22pt, weight: "semibold", fill: accent)
  v(0.3em)
  it
  v(0.5em)
}
#show heading.where(level: 2): set text(font: "Inter", size: 14pt, weight: "semibold")
#show heading.where(level: 3): set text(font: "Inter", size: 12pt, weight: "medium")

#show table.cell.where(y: 0): set text(weight: "semibold", fill: accent)
#set table(stroke: 0.5pt + rule, inset: 8pt)

// --- Cover ---------------------------------------------------------------
#page(header: none, footer: none, margin: (top: 6cm, bottom: 4cm, x: 3cm))[
  #text(font: "IBM Plex Serif", size: 38pt, weight: "semibold", fill: accent)[#title]
  #v(0.5em)
  #text(font: "Inter", size: 16pt, fill: muted)[#subtitle]
  #v(3em)
  #text(font: "Inter", size: 11pt, fill: muted)[
    #author · #date
  ]
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
