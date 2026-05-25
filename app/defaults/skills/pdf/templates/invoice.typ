// invoice.typ — DIN-A4 invoice template (DE/EN bilingual labels, USt-konform).
//
// Usage:
//   typst compile --input data=invoice.json invoice.typ invoice.pdf
//
// Expected invoice.json structure:
//   {
//     "from": { "name": "...", "address1": "...", "address2": "...", "tax_id": "...", "iban": "...", "bic": "..." },
//     "to":   { "name": "...", "address1": "...", "address2": "..." },
//     "invoice_no": "2026-001",
//     "date": "2026-05-25",
//     "due_date": "2026-06-25",
//     "items": [
//       { "description": "Beratung 4h", "qty": 4, "unit": "h", "unit_price": 180.00 },
//       ...
//     ],
//     "vat_rate": 0.19,
//     "currency": "EUR",
//     "notes": "..."
//   }

#let data = json(sys.inputs.at("data", default: "examples/invoice-sample.json"))

#let primary = rgb("#0F172A")
#let muted   = rgb("#64748B")
#let accent  = rgb("#0EA5E9")
#let rule    = rgb("#E2E8F0")

#set page(paper: "a4", margin: (top: 2.5cm, bottom: 2.5cm, x: 2cm))
#set text(font: "Inter", size: 10pt, fill: primary, lang: "de")

// --- Header / sender block -----------------------------------------------
#grid(
  columns: (1fr, auto),
  align: (left, right),
  [
    #text(font: "IBM Plex Serif", size: 24pt, weight: "semibold", fill: accent)[#data.from.name]
    #v(0.3em)
    #text(size: 9pt, fill: muted)[
      #data.from.address1 \
      #data.from.address2
    ]
  ],
  [
    #text(font: "IBM Plex Serif", size: 24pt, weight: "semibold")[RECHNUNG]
    #v(0.3em)
    #text(size: 9pt, fill: muted)[Invoice]
  ],
)

#v(1em)
#line(length: 100%, stroke: 0.5pt + rule)
#v(1em)

// --- Recipient + invoice metadata ----------------------------------------
#grid(
  columns: (1fr, 1fr),
  gutter: 2em,
  [
    #text(size: 9pt, fill: muted)[Rechnung an / Bill to]
    #v(0.3em)
    #text(weight: "semibold")[#data.to.name] \
    #data.to.address1 \
    #data.to.address2
  ],
  [
    #grid(
      columns: (auto, 1fr),
      gutter: 0.6em,
      text(size: 9pt, fill: muted)[Rechnungs-Nr.], text(weight: "semibold")[#data.invoice_no],
      text(size: 9pt, fill: muted)[Datum],         data.date,
      text(size: 9pt, fill: muted)[Fällig bis],    data.due_date,
    )
  ],
)

#v(2em)

// --- Line items ----------------------------------------------------------
#let fmt(n) = {
  let s = str(calc.round(n * 100) / 100)
  if not s.contains(".") { s = s + ".00" }
  let parts = s.split(".")
  parts.at(0) + "," + parts.at(1) + (if parts.at(1).len() == 1 { "0" } else { "" })
}

#table(
  columns: (auto, 1fr, auto, auto, auto, auto),
  align: (left, left, right, left, right, right),
  stroke: (x, y) => if y == 0 { (bottom: 0.5pt + accent) } else { (bottom: 0.25pt + rule) },
  inset: 8pt,
  table.header[Pos.][Beschreibung][Menge][Einheit][Einzelpreis][Gesamt],
  ..data.items.enumerate().map(((i, it)) => (
    str(i + 1),
    it.description,
    fmt(it.qty),
    it.unit,
    fmt(it.unit_price) + " " + data.currency,
    fmt(it.qty * it.unit_price) + " " + data.currency,
  )).flatten(),
)

#v(1em)

// --- Totals --------------------------------------------------------------
#let subtotal = data.items.fold(0.0, (acc, it) => acc + it.qty * it.unit_price)
#let vat = subtotal * data.vat_rate
#let total = subtotal + vat

#align(right)[
  #grid(
    columns: (auto, auto),
    gutter: 0.5em,
    align: (right, right),
    text(fill: muted)[Zwischensumme], fmt(subtotal) + " " + data.currency,
    text(fill: muted)[USt #calc.round(data.vat_rate * 100) %], fmt(vat) + " " + data.currency,
    text(weight: "semibold")[Gesamt], text(weight: "semibold", size: 14pt)[#fmt(total) #data.currency],
  )
]

#v(2em)

// --- Payment + notes -----------------------------------------------------
#text(size: 9pt, fill: muted)[Zahlbar per Überweisung bis #data.due_date auf folgendes Konto:]
#v(0.3em)
#table(
  columns: 2,
  stroke: none,
  inset: 4pt,
  align: (left, left),
  [*IBAN*], data.from.iban,
  [*BIC*], data.from.bic,
  [*USt-IdNr.*], data.from.tax_id,
)

#if data.at("notes", default: "") != "" [
  #v(1em)
  #text(size: 9pt, fill: muted)[#data.notes]
]
