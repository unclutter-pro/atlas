// invoice.typ — DIN-A4 invoice template, §14 UStG-conform, multi-page-safe, i18n.
//
// Pflichtangaben nach §14 Abs. 4 UStG implemented (German tax law):
//  1. Vollständiger Name + Anschrift Leistender + Empfänger
//  2. Steuernummer ODER USt-IdNr des Leistenden
//  3. Ausstellungsdatum
//  4. Fortlaufende Rechnungsnummer (einmalige Vergabe)
//  5. Menge + handelsübliche Bezeichnung der Lieferung/Leistung
//  6. Zeitpunkt der Lieferung/sonstigen Leistung
//  7. Nach Steuersätzen aufgeschlüsseltes Entgelt + Steuerbetrag
//  8. Anzuwendender Steuersatz oder Hinweis auf Steuerbefreiung
//  9. Bei Kleinunternehmer (§19): Hinweis "Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen"
//
// Languages: de (default) / en / fr — set via `"lang": "en"` in the JSON.
// Dates accept ISO YYYY-MM-DD; ranges like "2026-05-15 — 2026-05-23" are also handled.
//
// Combine with the helper script `scripts/invoice-zugferd` to produce a ZUGFeRD / Factur-X
// PDF/A-3 with embedded XML (EN 16931, EU e-invoice standard).
//
// Usage:
//   build-pdf invoice --data path/to/invoice.json [--theme indigo|...] invoice.pdf

#import "themes.typ": resolve-theme
#import "i18n.typ": t, format-date, format-date-or-range, format-money

// `data` input is an absolute path resolved by build-pdf. When invoked
// directly with `typst compile` and no --input, fall back to the bundled
// sample relative to this template.
#let data-path = sys.inputs.at("data", default: "../examples/invoice-sample.json")
#let data = json(data-path)

#let lang = data.at("lang", default: "de")
#let l = t(lang)

#let theme = resolve-theme()
#let primary    = theme.primary
#let accent     = theme.accent
#let muted      = theme.muted
#let rule       = theme.rule
#let background = theme.background
#let surface    = theme.surface
#let font-body    = theme.font-body
#let font-heading = theme.font-heading
#let font-mono    = theme.font-mono

// Kleinunternehmer-Mode (German small-business exemption — labels remain even in EN/FR)
#let is_kleinunternehmer = data.at("kleinunternehmer", default: false)
#let vat_rate = if is_kleinunternehmer { 0.0 } else { data.vat_rate }

#let inv-date = format-date(data.date, lang: lang)
#let due-date = format-date(data.due_date, lang: lang)
#let svc-date = format-date-or-range(data.at("service_date", default: data.date), lang: lang)

// Page layout — generous margins, modern feel, multi-page safe.
#set page(
  paper: "a4",
  margin: (top: 2.8cm, bottom: 3.5cm, x: 2.5cm),
  fill: background,
  header: context {
    if counter(page).get().first() > 1 {
      grid(
        columns: (1fr, auto),
        align: (left, right),
        text(size: 9pt, weight: "semibold", fill: primary)[#data.from.name],
        text(size: 9pt, fill: muted)[
          #l.invoice #data.invoice_no · #inv-date
        ],
      )
      v(0.3em)
      line(length: 100%, stroke: 0.3pt + rule)
    }
  },
  footer: context align(center)[
    #text(size: 8pt, fill: muted)[
      #l.page #counter(page).display() / #counter(page).final().last()
      · #data.from.name
      #if data.from.at("tax_id", default: "") != "" [ · #l.vat-id: #data.from.tax_id]
    ]
  ],
)

// All-sans, modern type stack — font from the active theme.
#set text(font: font-body, size: 10pt, fill: primary, lang: lang)
#set par(leading: 0.75em, spacing: 0.9em)

// --- Header: tall, modern title block ------------------------------------
// Invoice number is auto-scaled to fit. Long numbers (DATEV-style with
// project codes etc.) shrink from 28pt down to a still-prominent 14pt.
#let inv-no-size = {
  let n = data.invoice_no.len()
  if n > 24 { 14pt } else if n > 14 { 20pt } else { 28pt }
}

#grid(
  columns: (1fr, 40%),
  align: (left, top + right),
  column-gutter: 1.5em,
  [
    #text(size: 11pt, weight: "semibold", tracking: 0.1em, fill: accent)[#upper(l.invoice)]
    #v(0.4em)
    #text(size: 26pt, weight: "semibold")[#data.from.name]
    #v(0.4em)
    #text(size: 9pt, fill: muted)[
      #data.from.address1 · #data.from.address2
    ]
  ],
  [
    #text(size: inv-no-size, weight: "light", fill: muted)[№ #data.invoice_no]
  ],
)

#v(1em)
#line(length: 100%, stroke: 1pt + accent)
#v(2em)

// --- Recipient + invoice metadata grid -----------------------------------
#grid(
  columns: (1fr, 1fr),
  gutter: 2.5em,
  [
    #text(size: 8pt, tracking: 0.1em, fill: muted)[#upper(l.invoice-to)]
    #v(0.5em)
    #text(size: 11pt, weight: "semibold")[#data.to.name]
    #v(0.2em)
    #text(size: 10pt)[
      #data.to.address1 \
      #data.to.address2
      #if data.to.at("tax_id", default: "") != "" [\
        #text(size: 9pt, fill: muted)[#l.vat-id: #data.to.tax_id]
      ]
    ]
  ],
  [
    #grid(
      columns: (auto, 1fr),
      gutter: (0.8em, 0.5em),
      text(size: 9pt, fill: muted)[#l.invoice-no],  text(size: 10pt, weight: "semibold")[#data.invoice_no],
      text(size: 9pt, fill: muted)[#l.invoice-date], text(size: 10pt)[#inv-date],
      text(size: 9pt, fill: muted)[#l.service-date], text(size: 10pt)[#svc-date],
      text(size: 9pt, fill: muted)[#l.due-by],       text(size: 10pt, weight: "semibold")[#due-date],
    )
  ],
)

#v(3em)

// --- Line items table (multi-page safe via table.header repeat) ----------
#table(
  columns: (auto, 1fr, auto, auto, auto, auto),
  align: (left + horizon, left + horizon, right + horizon, left + horizon, right + horizon, right + horizon),
  stroke: (x, y) => (
    bottom: if y == 0 { 1pt + accent } else { 0.25pt + rule },
  ),
  inset: 10pt,
  table.header(
    text(size: 8pt, tracking: 0.1em, fill: accent)[#upper(l.pos)],
    text(size: 8pt, tracking: 0.1em, fill: accent)[#upper(l.description)],
    text(size: 8pt, tracking: 0.1em, fill: accent)[#upper(l.qty)],
    text(size: 8pt, tracking: 0.1em, fill: accent)[#upper(l.unit)],
    text(size: 8pt, tracking: 0.1em, fill: accent)[#upper(l.unit-price)],
    text(size: 8pt, tracking: 0.1em, fill: accent)[#upper(l.line-total)],
  ),
  ..data.items.enumerate().map(((i, it)) => (
    text(fill: muted)[#str(i + 1)],
    it.description,
    format-money(it.qty, lang: lang),
    it.unit,
    format-money(it.unit_price, lang: lang) + " " + data.currency,
    text(weight: "medium")[#format-money(it.qty * it.unit_price, lang: lang) #data.currency],
  )).flatten(),
)

#v(1.5em)

// --- Totals block, kept together (no page break inside) ------------------
#let subtotal = data.items.fold(0.0, (acc, it) => acc + it.qty * it.unit_price)
#let vat = subtotal * vat_rate
#let total = subtotal + vat

#block(breakable: false)[
  #table(
    columns: (1fr, auto),
    align: (right + horizon, right + horizon),
    stroke: none,
    inset: (x: 0pt, y: 6pt),
    column-gutter: 2.5em,
    text(size: 10pt, fill: muted)[#l.subtotal-net],
    text(size: 10pt)[#format-money(subtotal, lang: lang) #data.currency],
    ..(if is_kleinunternehmer { () } else {
      (
        text(size: 10pt, fill: muted)[#l.vat #calc.round(vat_rate * 100) %],
        text(size: 10pt)[#format-money(vat, lang: lang) #data.currency],
      )
    }),
    // thin rule above the grand total — only as wide as the amount column
    table.cell(colspan: 2, inset: (x: 0pt, y: 4pt))[
      #align(right)[#box(width: 7cm, line(length: 100%, stroke: 0.5pt + rule))]
    ],
    text(size: 11pt, weight: "semibold")[#l.grand-total],
    text(size: 16pt, weight: "semibold", fill: accent)[#format-money(total, lang: lang) #data.currency],
  )

  #if is_kleinunternehmer [
    #v(0.8em)
    #align(right)[
      #text(size: 9pt, fill: muted, style: "italic")[
        #l.kleinunternehmer-note
      ]
    ]
  ]
]

#v(2em)

// --- Payment block, also kept together -----------------------------------
#block(breakable: false)[
  #grid(
    columns: (1fr, 1fr),
    gutter: 2em,
    [
      #text(size: 8pt, tracking: 0.1em, fill: muted)[#upper(l.bank-details)]
      #v(0.5em)
      #table(
        columns: (auto, 1fr),
        stroke: none,
        inset: (x: 0pt, y: 4pt),
        column-gutter: 1em,
        align: (left + top, left + top),
        text(size: 9pt, fill: muted)[#l.iban],
        text(size: 10pt)[#data.from.iban],
        text(size: 9pt, fill: muted)[#l.bic],
        text(size: 10pt)[#data.from.bic],
        ..(if data.from.at("bank_name", default: "") != "" {
          (text(size: 9pt, fill: muted)[#l.bank-name], text(size: 10pt)[#data.from.bank_name])
        } else { () }),
      )
    ],
    [
      #text(size: 8pt, tracking: 0.1em, fill: muted)[#upper(l.payment-due)]
      #v(0.5em)
      #text(size: 11pt, weight: "semibold")[#due-date]
      #v(0.3em)
      #text(size: 9pt, fill: muted)[
        #l.remit-note.replace("{n}", data.invoice_no)
      ]
    ],
  )
]

#if data.at("notes", default: "") != "" [
  #v(1em)
  #block(
    width: 100%,
    inset: 10pt,
    fill: surface,
    radius: 4pt,
    breakable: false,
  )[
    #text(size: 9pt, fill: muted)[#data.notes]
  ]
]
