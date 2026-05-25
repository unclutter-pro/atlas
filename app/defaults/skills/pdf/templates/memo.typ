// memo.typ — internal memo / status update template.
//
// Memos *prefer* a single page, but multi-page memos are fine when the
// content earns it. Page breaks are clean: section headings never get
// orphaned at the bottom, the header bar appears only on page 1, and
// subsequent pages carry a slim continuation header.
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

// Page setup with continuation header + footer that only appear from page 2.
// Page 1 gets the full header bar block; pages 2+ get a slim title strip and
// a centred page counter so multi-page memos still read coherent.
#set page(
  paper: "a4",
  margin: (top: 2.5cm, bottom: 2.5cm, x: 2.5cm),
  fill: background,
  header: context {
    if counter(page).get().first() > 1 {
      grid(
        columns: (1fr, auto),
        align: (left, right),
        text(size: 9pt, weight: "semibold", fill: primary)[#l.memo-to: #to],
        text(size: 9pt, fill: muted)[#title · #date],
      )
      v(0.3em)
      line(length: 100%, stroke: 0.3pt + rule)
    }
  },
  footer: context {
    let total = counter(page).final().last()
    if total > 1 {
      align(center)[
        #text(size: 9pt, fill: muted)[
          #l.page #counter(page).display() / #total
        ]
      ]
    }
  },
)
#set text(font: font-body, size: 11pt, fill: primary, lang: lang)
#set par(justify: true, leading: 0.7em, spacing: 1em)

// Body headings rely on size + weight, not colour. Restraint over emphasis.
// The heading itself + at least the first paragraph that follows must stay
// together — protects against orphaned headings at page bottoms.
#show heading.where(level: 1): it => block(breakable: false)[
  #v(0.8em)
  #text(font: font-body, size: 13pt, weight: "semibold", fill: primary, tracking: 0.02em)[#it]
  #v(0.3em)
  #line(length: 1.5em, stroke: 1.5pt + accent)
  #v(0.4em)
]

// --- Header bar (page 1 only — placeholder block grows naturally) -------
// One single splash of accent: the eyebrow "MEMO". Title in primary so the
// heading family carries the personality, not the colour. The header is a
// regular content block, so if you choose to split a memo across pages it
// just doesn't repeat.
#block(
  width: 100%,
  fill: surface,
  inset: 16pt,
  radius: 6pt,
  breakable: false,
)[
  #text(size: 9pt, tracking: 0.18em, weight: "semibold", fill: accent)[#upper("Memo")]
  #v(0.3em)
  // Title auto-shrinks so long titles still fit on one line. Tight leading
  // (0.3em vs body 0.7em) keeps wrapped title lines visually as ONE block.
  #let title-size = {
    let n = title.len()
    if n > 60 { 14pt } else if n > 35 { 17pt } else { 20pt }
  }
  #par(leading: 0.3em)[
    #text(font: font-heading, size: title-size, weight: "semibold", fill: primary)[#title]
  ]
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

Bullet-Liste oder kurze Absätze. Mehrere Seiten sind ok, wenn der Inhalt es verdient — die Seiten werden sauber getrennt (Überschriften brechen nicht, ab Seite 2 erscheint ein schmaler Continuation-Header).

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
