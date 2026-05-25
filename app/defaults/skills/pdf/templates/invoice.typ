// invoice.typ — DIN-A4 invoice template, §14 UStG-conform.
//
// Pflichtangaben nach §14 Abs. 4 UStG implemented:
//  1. Vollständiger Name + Anschrift Leistender + Empfänger
//  2. Steuernummer ODER USt-IdNr des Leistenden
//  3. Ausstellungsdatum
//  4. Fortlaufende Rechnungsnummer (einmalige Vergabe)
//  5. Menge + handelsübliche Bezeichnung der Lieferung/Leistung
//  6. Zeitpunkt der Lieferung/sonstigen Leistung (auch wenn = Rechnungsdatum)
//  7. Nach Steuersätzen aufgeschlüsseltes Entgelt + Steuerbetrag
//  8. Anzuwendender Steuersatz oder Hinweis auf Steuerbefreiung
//  9. Bei Kleinunternehmer (§19): Hinweis "Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen"
//
// Combine with the helper script `scripts/invoice-zugferd` to produce a ZUGFeRD / Factur-X
// PDF/A-3 with embedded XML (EN 16931, EU e-invoice standard).
//
// Usage:
//   build-pdf invoice --data path/to/invoice.json [--theme indigo|...] invoice.pdf

#import "themes.typ": resolve-theme

#let data = json(sys.inputs.at("data", default: "examples/invoice-sample.json"))

#let theme = resolve-theme()
#let primary = theme.primary
#let accent  = theme.accent
#let muted   = theme.muted
#let rule    = theme.rule

// --- Kleinunternehmer-Modus erkennen --------------------------------------
#let is_kleinunternehmer = data.at("kleinunternehmer", default: false)
#let vat_rate = if is_kleinunternehmer { 0.0 } else { data.vat_rate }

#set page(paper: "a4", margin: (top: 2.8cm, bottom: 2.8cm, x: 2.5cm))
#set text(font: "Inter", size: 10pt, fill: primary, lang: "de")
#set par(leading: 0.7em)

// --- Header: Absender + RECHNUNG-Heading ----------------------------------
#grid(
  columns: (1fr, auto),
  align: (left, right),
  [
    #text(font: "IBM Plex Serif", size: 22pt, weight: "semibold", fill: accent)[#data.from.name]
    #v(0.4em)
    #text(size: 9pt, fill: muted)[
      #data.from.address1 \
      #data.from.address2
    ]
  ],
  [
    #text(font: "IBM Plex Serif", size: 22pt, weight: "semibold")[RECHNUNG]
    #v(0.3em)
    #text(size: 9pt, fill: muted)[Invoice]
  ],
)

#v(1.5em)
#line(length: 100%, stroke: 0.5pt + rule)
#v(1.5em)

// --- Empfänger + Rechnungs-Metadaten --------------------------------------
#grid(
  columns: (1fr, 1fr),
  gutter: 2.5em,
  [
    #text(size: 9pt, fill: muted)[Rechnung an / Bill to]
    #v(0.4em)
    #text(weight: "semibold")[#data.to.name] \
    #data.to.address1 \
    #data.to.address2
    #if data.to.at("tax_id", default: "") != "" [\
      USt-IdNr: #data.to.tax_id
    ]
  ],
  [
    #grid(
      columns: (auto, 1fr),
      gutter: 0.8em,
      text(size: 9pt, fill: muted)[Rechnungs-Nr.], text(weight: "semibold")[#data.invoice_no],
      text(size: 9pt, fill: muted)[Ausstellungsdatum], data.date,
      text(size: 9pt, fill: muted)[Leistungsdatum],   data.at("service_date", default: data.date),
      text(size: 9pt, fill: muted)[Fällig bis],       data.due_date,
    )
  ],
)

#v(2.5em)

// --- Number formatter (Euro with German decimal comma) -------------------
#let fmt(n) = {
  let s = str(calc.round(n * 100) / 100)
  if not s.contains(".") { s = s + ".00" }
  let parts = s.split(".")
  let cents = if parts.at(1).len() == 1 { parts.at(1) + "0" } else { parts.at(1) }
  parts.at(0) + "," + cents
}

// --- Positionen-Tabelle ---------------------------------------------------
#table(
  columns: (auto, 1fr, auto, auto, auto, auto),
  align: (left, left, right, left, right, right),
  stroke: (x, y) => if y == 0 { (bottom: 0.6pt + accent) } else { (bottom: 0.25pt + rule) },
  inset: 9pt,
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

#v(1.5em)

// --- Summen ---------------------------------------------------------------
#let subtotal = data.items.fold(0.0, (acc, it) => acc + it.qty * it.unit_price)
#let vat = subtotal * vat_rate
#let total = subtotal + vat

#align(right)[
  #grid(
    columns: (auto, auto),
    gutter: 0.6em,
    align: (right, right),
    text(fill: muted)[Zwischensumme (netto)], fmt(subtotal) + " " + data.currency,
    ..(if is_kleinunternehmer { () } else {
      (
        text(fill: muted)[USt #calc.round(vat_rate * 100) %], fmt(vat) + " " + data.currency,
      )
    }),
    text(weight: "semibold", size: 12pt)[Gesamtbetrag],
      text(weight: "semibold", size: 14pt, fill: accent)[#fmt(total) #data.currency],
  )
]

// --- Kleinunternehmer-Hinweis nach §19 UStG -------------------------------
#if is_kleinunternehmer [
  #v(1em)
  #align(right)[
    #text(size: 9pt, fill: muted, style: "italic")[
      Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen.
    ]
  ]
]

#v(2.5em)
#line(length: 100%, stroke: 0.25pt + rule)
#v(1.5em)

// --- Zahlungsinfo + Steuerangaben ----------------------------------------
#text(size: 9pt, fill: muted)[Zahlbar per Überweisung bis #data.due_date auf folgendes Konto:]
#v(0.4em)
#table(
  columns: 2,
  stroke: none,
  inset: 5pt,
  align: (left, left),
  [*IBAN*], data.from.iban,
  [*BIC*], data.from.bic,
  ..(if data.from.at("bank_name", default: "") != "" {
    ([*Bank*], data.from.bank_name)
  } else { () }),
)

#v(1em)

#text(size: 8pt, fill: muted)[
  #data.from.name · #data.from.address1, #data.from.address2 \
  #if data.from.at("tax_id", default: "") != "" [USt-IdNr.: #data.from.tax_id · ]
  #if data.from.at("steuernummer", default: "") != "" [Steuernr.: #data.from.steuernummer · ]
  #if data.from.at("phone", default: "") != "" [#data.from.phone · ]
  #if data.from.at("email", default: "") != "" [#data.from.email]
]

#if data.at("notes", default: "") != "" [
  #v(1em)
  #text(size: 9pt, fill: muted)[#data.notes]
]
