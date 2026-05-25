// letter.typ — DIN-5008 business letter template.
//
// Usage:
//   build-pdf letter --data letter.json [--theme indigo|...] letter.pdf

#import "themes.typ": resolve-theme

// `data` input is an absolute path resolved by build-pdf. Fallback used only
// when invoking `typst compile` directly without --input data=...
#let data-path = sys.inputs.at("data", default: "../examples/letter-sample.json")
#let data = json(data-path)
#let theme = resolve-theme()
#let primary = theme.primary
#let muted   = theme.muted

#set page(
  paper: "a4",
  margin: (top: 4.5cm, bottom: 2.5cm, left: 2.5cm, right: 2cm),
)
#set text(font: "Inter", size: 11pt, fill: primary, lang: "de")
#set par(justify: false, leading: 0.7em, first-line-indent: 0pt, spacing: 1em)

// --- Sender address (small, top-right) -----------------------------------
#place(top + right, dx: 0pt, dy: -2.5cm)[
  #text(size: 8pt, fill: muted)[
    #data.sender.name \
    #if data.sender.at("company", default: "") != "" [#data.sender.company \ ]
    #data.sender.address \
    #data.sender.city \
    \
    #if data.sender.at("phone", default: "") != "" [Tel #data.sender.phone \ ]
    #data.sender.email
  ]
]

// --- Sender line above recipient window (DIN 5008 Rücksendezeile) -------
#place(top + left, dx: 0pt, dy: -1.5cm)[
  #underline(stroke: 0.4pt)[
    #text(size: 7pt)[
      #data.sender.name · #data.sender.address · #data.sender.city
    ]
  ]
]

// --- Recipient (in the postal window area) -------------------------------
#text(size: 11pt)[
  #data.recipient.name \
  #if data.recipient.at("company", default: "") != "" [#data.recipient.company \ ]
  #data.recipient.address \
  #data.recipient.city
]

#v(2cm)

// --- Date + subject ------------------------------------------------------
#align(right)[#text(size: 10pt)[#data.date]]

#v(1em)
#text(weight: "semibold")[Betreff: #data.subject]

#v(1.5em)

// --- Body ---------------------------------------------------------------
#data.salutation

#v(0.5em)

#data.body.split("\n\n").map(p => par(p)).join(v(0.5em))

#v(1em)

#data.closing

#v(2em)

#data.signature
