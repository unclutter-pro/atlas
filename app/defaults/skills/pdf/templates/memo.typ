// memo.typ — short internal memo / status update (single page).
//
// Usage:
//   build-pdf memo --title "Sprint Recap KW 22" --to "Team" --from "Atlas" [--lang en|fr] [--theme indigo|...] memo.pdf

#import "themes.typ": resolve-theme
#import "i18n.typ": t, format-date

#let title = sys.inputs.at("title", default: "Memo")
#let to    = sys.inputs.at("to",    default: "—")
#let from  = sys.inputs.at("from",  default: "—")
#let lang  = sys.inputs.at("lang",  default: "de")
#let l     = t(lang)

// Date input: ISO YYYY-MM-DD (locale-formatted) or any free-form string (passed through).
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

#set page(paper: "a4", margin: (top: 2.5cm, bottom: 2.5cm, x: 2.5cm), fill: background)
#set text(font: font-body, size: 11pt, fill: primary, lang: lang)
#set par(justify: true, leading: 0.7em, spacing: 1em)

#show heading.where(level: 1): it => {
  v(0.8em)
  set text(font: font-body, size: 14pt, weight: "semibold", fill: accent)
  it
  v(0.4em)
}

// --- Header bar ----------------------------------------------------------
#block(
  width: 100%,
  fill: surface,
  inset: 16pt,
  radius: 6pt,
)[
  #text(font: font-heading, size: 18pt, weight: "semibold", fill: accent)[Memo · #title]
  #v(0.6em)
  #grid(
    columns: (auto, 1fr, auto, 1fr),
    gutter: (0.6em, 2em, 0.6em),
    text(size: 9pt, fill: muted)[#l.memo-to:], text(size: 10pt, weight: "semibold")[#to],
    text(size: 9pt, fill: muted)[#l.memo-from:], text(size: 10pt, weight: "semibold")[#from],
  )
  #v(0.3em)
  #grid(
    columns: (auto, 1fr),
    gutter: 0.6em,
    text(size: 9pt, fill: muted)[#l.memo-date:], text(size: 10pt)[#date],
  )
]

#v(2em)

// --- Body ---------------------------------------------------------------
#heading(l.memo-happened)

Bullet-Liste oder kurze Absätze. Memo ist *eine Seite*. Mehr → Report.

- *Punkt 1.*
- *Punkt 2.*
- *Punkt 3.*

#heading(l.memo-decisions)

- *Entscheidung A:* ja/nein/vertagt + Begründung.

#heading(l.memo-next-steps)

#v(0.3em)

#table(
  columns: (auto, 1fr, auto),
  align: (left, left, left),
  stroke: 0.5pt + rule,
  inset: 10pt,
  table.header(l.memo-owner, l.memo-task, l.memo-deadline),
  [Person A], [Tut X.], [KW 23],
  [Person B], [Liefert Y.], [Ende Mai],
)
