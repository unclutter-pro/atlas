// letter.typ — DIN-5008-style business letter template.
//
// The page geometry (4.5cm header, recipient window position, Rücksendezeile,
// right-aligned date + bold subject) follows German DIN 5008. The same layout
// is perfectly usable for EN/FR letters — only the labels change.
//
// Usage:
//   build-pdf letter --data letter.json [--theme indigo|...] letter.pdf
//
// JSON may include `"lang": "en" | "fr"` (default: "de") for the date format
// and (when subject is provided as plain text) the "Subject:" label.

#import "themes.typ": resolve-theme
#import "i18n.typ": format-date

// `data` input is an absolute path resolved by build-pdf. Fallback used only
// when invoking `typst compile` directly without --input data=...
#let data-path = sys.inputs.at("data", default: "../examples/letter-sample.json")
#let data = json(data-path)
#let lang = data.at("lang", default: "de")
#let subject-label = (
  de: "Betreff",
  en: "Subject",
  fr: "Objet",
).at(lang, default: "Betreff")

#let theme = resolve-theme()
#let primary = theme.primary
#let muted   = theme.muted

#set page(
  paper: "a4",
  margin: (top: 4.5cm, bottom: 2.5cm, left: 2.5cm, right: 2cm),
)
#set text(font: "Inter", size: 11pt, fill: primary, lang: lang)
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
#align(right)[#text(size: 10pt)[#format-date(data.date, lang: lang)]]

#v(1em)
#text(weight: "semibold")[#subject-label: #data.subject]

#v(1.5em)

// --- Body ---------------------------------------------------------------
#data.salutation

#v(0.5em)

#data.body.split("\n\n").map(p => par(p)).join(v(0.5em))

#v(1em)

#data.closing

#v(2em)

#data.signature
