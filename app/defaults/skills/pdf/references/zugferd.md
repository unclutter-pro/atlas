# ZUGFeRD / Factur-X E-Invoices

How the `invoice-zugferd` helper produces an EU-conform e-invoice (EN 16931), and what to know when working with it.

## What is Factur-X

Factur-X is the joint Franco-German implementation of **ZUGFeRD 2.x**, aligned with the EU norm **EN 16931** for electronic invoices. The format is:

- **A PDF/A-3 file** — Archive-format PDF allowing arbitrary file attachments.
- **One attached XML** named `factur-x.xml`, conforming to the **CII** (Cross-Industry Invoice) schema from UN/CEFACT.

The human reads the PDF, the recipient's accounting software (DATEV, SAP, Lexware, sevDesk, ...) reads the XML and auto-books the invoice.

## When you need this

- **Germany B2B**: receiving capability is mandatory since 01.01.2025. Issuing capability becomes mandatory:
  - 2027 for businesses with >800k€ annual revenue
  - 2028 for everyone else
- **Public sector** (Bund + Länder): mandatory since 2020 (XRechnung profile preferred for that channel, see below).
- Cross-border EU B2B: required for some Member State combinations under the EU's VAT-in-the-Digital-Age (ViDA) framework.

## How to generate one

```bash
# Step 1: render the visual PDF with the invoice template
build-pdf invoice --data path/to/invoice.json invoice.pdf

# Step 2: embed the CII XML, producing the Factur-X PDF/A-3
invoice-zugferd invoice.pdf path/to/invoice.json invoice_factur-x.pdf
```

The helper script lives in `scripts/invoice-zugferd`. It reads the same JSON the template used, so there's no data duplication and no risk of drift between the rendered values and the XML.

## What the helper emits

A CII XML conforming to the **EN 16931** profile. Selected fields it sets:

| Field (BT-/BG-) | Source in invoice JSON |
|---|---|
| BT-1 Invoice number | `invoice_no` |
| BT-2 Invoice issue date | `date` |
| BT-9 Payment due date | `due_date` |
| BT-72 Actual delivery date | last day of `service_date` (single date or end of range) |
| BG-14 Invoicing period | `service_date` if it's a range |
| BT-13 Buyer reference | not yet (TODO) |
| BG-4 Seller party | `from.*` |
| BG-7 Buyer party | `to.*` |
| BT-31 Seller VAT identifier | `from.tax_id` |
| BT-48 Buyer VAT identifier | `to.tax_id` |
| BG-22 Document level summation | computed (subtotal + VAT + total) |
| BG-23 VAT breakdown | computed (one rate per invoice for now) |
| BT-118 VAT category code | `S` (standard) or `E` (exempt, set when `kleinunternehmer: true`) |
| BT-120 VAT exemption reason | "Kleinunternehmer §19 UStG" when applicable |

## Validating the output

After running the helper, two validators are available:

```bash
# Syntactic + semantic validation against the Factur-X schematron
~/.local/bin/facturx-xmlcheck invoice_factur-x.pdf

# Re-extract the XML and inspect
python3 -c "
from facturx import get_facturx_xml_from_pdf
with open('invoice_factur-x.pdf','rb') as f:
    level, xml = get_facturx_xml_from_pdf(f.read())
print('Profile:', level)
print(xml.decode())
"
```

A green run means the XML passes both XSD (schema) and schematron (business rules) — that's the EU recipient's baseline.

## Limitations of the current helper

Edge cases not yet covered (in priority order — open an issue/PR if you need one):

1. **Multiple VAT rates per invoice** — e.g. 7 % for meals + 19 % for consulting. Currently one rate per invoice.
2. **Skonto / Cash discount** (BG-20, BT-91…) — payment-conditional discounts.
3. **Reverse charge** (BG-23 category code `AE` / `K`) for §13b UStG and intra-EU services.
4. **Down-payment invoices and final invoices** (TypeCode 386 / 389 mixed flows).
5. **XRechnung profile** — public-sector preferred format. The current helper emits the EN 16931 profile, which most public-sector portals accept, but XRechnung adds a few German-specific identifiers (Leitweg-ID, etc.).

## Profiles supported by Factur-X (--profile flag)

| Profile | Use |
|---|---|
| `MINIMUM` | Buyer + seller + totals only. Rarely useful in practice. |
| `BASIC WL` | "Without lines" — totals + tax breakdown, no line items. |
| `BASIC` | Totals + line items. |
| `EN 16931` ← **default** | Full EU baseline. The right answer for most B2B. |
| `EXTENDED` | EN 16931 + delivery refs and extended fields. |

The helper defaults to `EN 16931`. To switch:

```bash
invoice-zugferd invoice.pdf data.json out.pdf --profile EXTENDED
```

## Recipient compatibility (informal)

- **DATEV** — accepts EN 16931 since DATEV Belege Online 2024. Auto-imports.
- **SAP / S/4HANA** — accepts via the e-invoice receiver service. May need a wrapper depending on customizing.
- **Lexware / Lexoffice** — accepts since 2024. Buchungsvorschlag generiert.
- **sevDesk** — accepts via the Beleg-Import.
- **XRechnung public-sector portal** (ZRE / OZG-RE) — needs the XRechnung profile, not plain EN 16931. Use a converter if you don't have an XRechnung-capable issuer.

When you hit a recipient that rejects our output, please grab the validator output they send back — schematron messages name the failing rule (e.g. `BR-CO-15` = total mismatch) and we can fix the helper directly.

## See also

- `scripts/invoice-zugferd` — the helper itself, ~250 LOC of Python.
- `templates/invoice.typ` — the visual PDF this XML attaches to.
- `examples/invoice-sample.json` — sample input data.
- EU norm reference: <https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/eInvoicing>
- ZUGFeRD spec: <https://www.ferd-net.de/standards/zugferd-2.3/>
