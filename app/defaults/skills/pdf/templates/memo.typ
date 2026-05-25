// memo.typ — short internal memo / status update (single page).
//
// Usage:
//   build-pdf memo --title "Sprint Recap KW 22" --to "Team" --from "Atlas" [--theme indigo|...] memo.pdf

#import "themes.typ": resolve-theme

#let title = sys.inputs.at("title", default: "Memo-Titel")
#let to    = sys.inputs.at("to",    default: "Empfänger")
#let from  = sys.inputs.at("from",  default: "Absender")
#let date  = sys.inputs.at("date",  default: datetime.today().display())

#let theme = resolve-theme()
#let primary = theme.primary
#let accent  = theme.accent
#let muted   = theme.muted
#let rule    = theme.rule

#set page(paper: "a4", margin: (top: 2.5cm, bottom: 2.5cm, x: 2.5cm))
#set text(font: "Inter", size: 11pt, fill: primary, lang: "de")
#set par(justify: true, leading: 0.7em, spacing: 1em)

#show heading.where(level: 1): it => {
  v(0.8em)
  set text(font: "Inter", size: 14pt, weight: "semibold", fill: accent)
  it
  v(0.4em)
}

// --- Header bar ----------------------------------------------------------
#block(
  width: 100%,
  fill: rule.lighten(40%),
  inset: 16pt,
  radius: 6pt,
)[
  #text(font: "IBM Plex Serif", size: 18pt, weight: "semibold", fill: accent)[Memo · #title]
  #v(0.6em)
  #grid(
    columns: (auto, 1fr, auto, 1fr),
    gutter: (0.6em, 2em, 0.6em),
    text(size: 9pt, fill: muted)[An:], text(size: 10pt, weight: "semibold")[#to],
    text(size: 9pt, fill: muted)[Von:], text(size: 10pt, weight: "semibold")[#from],
  )
  #v(0.3em)
  #grid(
    columns: (auto, 1fr),
    gutter: 0.6em,
    text(size: 9pt, fill: muted)[Datum:], text(size: 10pt)[#date],
  )
]

#v(2em)

// --- Body ---------------------------------------------------------------
= Was passiert ist

Bullet-Liste oder kurze Absätze. Memo ist *eine Seite*. Mehr → Report.

- *Punkt 1.*
- *Punkt 2.*
- *Punkt 3.*

= Entscheidungen

- *Entscheidung A:* ja/nein/vertagt + Begründung.

= Nächste Schritte

#v(0.3em)

#table(
  columns: (auto, 1fr, auto),
  align: (left, left, left),
  stroke: 0.5pt + rule,
  inset: 10pt,
  table.header[Wer][Was][Wann],
  [Person A], [Tut X.], [KW 23],
  [Person B], [Liefert Y.], [Ende Mai],
)
