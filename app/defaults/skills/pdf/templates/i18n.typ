// i18n.typ — locale-aware labels, date formatter, money formatter.
//
// Usage in a template:
//
//   #import "i18n.typ": t, format-date, format-money
//   #let lang = data.at("lang", default: "de")
//   #let l = t(lang)
//
// Then replace any hardcoded label with `l.invoice`, `l.due-by`, etc.
// Dates: `format-date("2026-05-25", lang)` → "25.05.2026" / "2026-05-25" / "25/05/2026"
// Money: `format-money(4379.20, lang)` → "4.379,20" / "4,379.20" / "4 379,20"
//
// Supported langs: de (default), en, fr. Falls back to `de` for unknown codes.

#let labels = (
  de: (
    // invoice
    invoice: "Rechnung",
    invoice-to: "Rechnung an",
    invoice-no: "Rechnungsnummer",
    invoice-date: "Rechnungsdatum",
    service-date: "Leistungsdatum",
    due-by: "Fällig bis",
    pos: "Pos.",
    description: "Beschreibung",
    qty: "Menge",
    unit: "Einh.",
    unit-price: "Einzelpreis",
    line-total: "Gesamt",
    subtotal: "Zwischensumme",
    subtotal-net: "Zwischensumme (netto)",
    vat: "USt",
    grand-total: "Gesamtbetrag",
    bank-details: "Bankverbindung",
    payment-due: "Zahlungsziel",
    remit-note: "Bitte unter Angabe der Rechnungs-Nr. {n} überweisen.",
    iban: "IBAN",
    bic: "BIC",
    bank-name: "Bank",
    vat-id: "USt-IdNr.",
    tax-id: "Steuernummer",
    kleinunternehmer-note: "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).",
    // letter
    page: "Seite",
    page-of: "Seite {n} / {total}",
    // memo
    memo-happened: "Was passiert ist",
    memo-decisions: "Entscheidungen",
    memo-next-steps: "Nächste Schritte",
    memo-owner: "Owner",
    memo-task: "Aufgabe",
    memo-deadline: "Deadline",
    memo-to: "An",
    memo-from: "Von",
    memo-date: "Datum",
    // report
    report-toc: "Inhalt",
    report-by: "Von",
  ),
  en: (
    // invoice
    invoice: "Invoice",
    invoice-to: "Invoice to",
    invoice-no: "Invoice number",
    invoice-date: "Invoice date",
    service-date: "Service date",
    due-by: "Due by",
    pos: "No.",
    description: "Description",
    qty: "Qty",
    unit: "Unit",
    unit-price: "Unit price",
    line-total: "Total",
    subtotal: "Subtotal",
    subtotal-net: "Subtotal (net)",
    vat: "VAT",
    grand-total: "Grand total",
    bank-details: "Bank details",
    payment-due: "Payment due",
    remit-note: "Please reference invoice number {n} on your transfer.",
    iban: "IBAN",
    bic: "BIC",
    bank-name: "Bank",
    vat-id: "VAT ID",
    tax-id: "Tax ID",
    kleinunternehmer-note: "No VAT charged under § 19 UStG (small business regulation).",
    // letter
    page: "Page",
    page-of: "Page {n} of {total}",
    // memo
    memo-happened: "What happened",
    memo-decisions: "Decisions",
    memo-next-steps: "Next steps",
    memo-owner: "Owner",
    memo-task: "Task",
    memo-deadline: "Deadline",
    memo-to: "To",
    memo-from: "From",
    memo-date: "Date",
    // report
    report-toc: "Contents",
    report-by: "By",
  ),
  fr: (
    invoice: "Facture",
    invoice-to: "Facturé à",
    invoice-no: "Numéro de facture",
    invoice-date: "Date de facture",
    service-date: "Date de prestation",
    due-by: "Date d'échéance",
    pos: "Nº",
    description: "Description",
    qty: "Qté",
    unit: "Unité",
    unit-price: "Prix unitaire",
    line-total: "Total",
    subtotal: "Sous-total",
    subtotal-net: "Sous-total (HT)",
    vat: "TVA",
    grand-total: "Total général",
    bank-details: "Coordonnées bancaires",
    payment-due: "Échéance",
    remit-note: "Veuillez indiquer le numéro de facture {n} lors du virement.",
    iban: "IBAN",
    bic: "BIC",
    bank-name: "Banque",
    vat-id: "Nº TVA",
    tax-id: "Nº fiscal",
    kleinunternehmer-note: "TVA non applicable (régime de la franchise en base).",
    page: "Page",
    page-of: "Page {n} sur {total}",
    memo-happened: "Ce qui s'est passé",
    memo-decisions: "Décisions",
    memo-next-steps: "Prochaines étapes",
    memo-owner: "Responsable",
    memo-task: "Tâche",
    memo-deadline: "Échéance",
    memo-to: "À",
    memo-from: "De",
    memo-date: "Date",
    report-toc: "Sommaire",
    report-by: "Par",
  ),
)

#let t(lang) = labels.at(lang, default: labels.de)

// format-date — accepts ISO "YYYY-MM-DD" (most common), passes through anything
// else (e.g. ranges, free-form strings). Optionally accepts ISO datetime that
// includes time — only the date part is used.
#let format-date(iso, lang: "de") = {
  if type(iso) != str { return str(iso) }
  let date-part = iso.split("T").at(0)
  let parts = date-part.split("-")
  if parts.len() != 3 { return iso }
  let (y, m, d) = (parts.at(0), parts.at(1), parts.at(2))
  if y.len() != 4 or m.len() != 2 or d.len() != 2 { return iso }
  if lang == "de" { d + "." + m + "." + y }
  else if lang == "fr" { d + "/" + m + "/" + y }
  else { y + "-" + m + "-" + d }  // EN / others: ISO — unambiguous internationally
}

// Format possibly-a-range date strings like "2026-05-15 — 2026-05-23" or
// "2026-05-15 - 2026-05-23". Both ends get formatted; separator preserved.
#let _range-separators = (" — ", " – ", " - ", " bis ", " to ")
#let format-date-or-range(s, lang: "de") = {
  if type(s) != str { return str(s) }
  for sep in _range-separators {
    if s.contains(sep) {
      let parts = s.split(sep)
      if parts.len() == 2 {
        return format-date(parts.at(0).trim(), lang: lang) + sep + format-date(parts.at(1).trim(), lang: lang)
      }
    }
  }
  format-date(s, lang: lang)
}

// format-money — two-decimal formatter, locale-aware thousands separator + decimal mark.
//   de: "4.379,20"   en: "4,379.20"   fr: "4 379,20"
#let format-money(n, lang: "de") = {
  let s = str(calc.round(n * 100) / 100)
  if not s.contains(".") { s = s + ".00" }
  let parts = s.split(".")
  let int-part = parts.at(0)
  let cents = if parts.at(1).len() == 1 { parts.at(1) + "0" } else { parts.at(1) }

  // Thousands grouping
  let negative = int-part.starts-with("-")
  let abs-int = if negative { int-part.slice(1) } else { int-part }

  let thousands-sep = if lang == "de" { "." }
                      else if lang == "fr" { "\u{00A0}" }  // narrow space
                      else { "," }
  let decimal-sep = if lang == "en" { "." } else { "," }

  let n-chars = abs-int.len()
  let grouped = ""
  let i = 0
  while i < n-chars {
    let pos-from-end = n-chars - i
    grouped = grouped + abs-int.at(i)
    if pos-from-end > 1 and calc.rem(pos-from-end - 1, 3) == 0 {
      grouped = grouped + thousands-sep
    }
    i = i + 1
  }
  let sign = if negative { "-" } else { "" }
  sign + grouped + decimal-sep + cents
}
