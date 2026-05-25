// memo.typ — short internal memo / status update (single page).
//
// Usage:
//   typst compile --input title="Sprint Recap KW 22" --input to="Team" --input from="Atlas" memo.typ memo.pdf

#let title = sys.inputs.at("title", default: "Memo-Titel")
#let to    = sys.inputs.at("to",    default: "Empfänger")
#let from  = sys.inputs.at("from",  default: "Absender")
#let date  = sys.inputs.at("date",  default: datetime.today().display())

#set page(paper: "a4", margin: (top: 2cm, bottom: 2cm, x: 2cm))
#set text(font: "Inter", size: 11pt, lang: "de")
#set par(justify: true, leading: 0.65em)

// --- Header bar ----------------------------------------------------------
#block(
  width: 100%,
  fill: rgb("#F1F5F9"),
  inset: 12pt,
  radius: 4pt,
)[
  #text(font: "IBM Plex Serif", size: 16pt, weight: "semibold")[Memo · #title]
  #v(0.3em)
  #grid(
    columns: (auto, 1fr, auto, 1fr),
    gutter: (0.5em, 1.5em, 0.5em),
    text(size: 9pt, fill: rgb("#64748B"))[An:], text(size: 9pt, weight: "semibold")[#to],
    text(size: 9pt, fill: rgb("#64748B"))[Von:], text(size: 9pt, weight: "semibold")[#from],
  )
  #grid(
    columns: (auto, 1fr),
    gutter: 0.5em,
    text(size: 9pt, fill: rgb("#64748B"))[Datum:], text(size: 9pt)[#date],
  )
]

#v(1em)

// --- Body ---------------------------------------------------------------
= Was passiert ist

Bullet-Liste oder kurze Absätze. Memo ist *eine Seite*. Mehr → Report.

- *Punkt 1.*
- *Punkt 2.*
- *Punkt 3.*

= Entscheidungen

- *Entscheidung A:* ja/nein/vertagt + Begründung.

= Nächste Schritte

#table(
  columns: (auto, 1fr, auto),
  align: (left, left, left),
  stroke: 0.5pt + rgb("#E2E8F0"),
  inset: 8pt,
  table.header[Wer][Was][Wann],
  [Person A], [Tut X.], [KW 23],
  [Person B], [Liefert Y.], [Ende Mai],
)
