---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files.

## Quick Reference

| Task | Approach |
|------|----------|
| Standard business doc (letter, report, memo, invoice) | Start from a ready-made template in `assets/templates/` — see Templates below |
| Read/analyze content | `pandoc` or unpack for raw XML |
| Create a custom document | Use `docx-js` — see Creating New Documents below |
| Edit existing document | Unpack → edit XML → repack — see Editing Existing Documents below |

### Converting .doc to .docx

Legacy `.doc` files must be converted before editing:

```bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
```

### Reading Content

```bash
# Text extraction with tracked changes
pandoc --track-changes=all document.docx -o output.md

# Raw XML access
python scripts/office/unpack.py document.docx unpacked/
```

### Converting to Images

```bash
python scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

### Accepting Tracked Changes

To produce a clean document with all tracked changes accepted (requires LibreOffice):

```bash
python scripts/accept_changes.py input.docx output.docx
```

---

## Templates (start here for standard documents)

For the most common deliverables, don't build from scratch — copy a ready-made template from `assets/templates/` and edit its data. Each is a standalone **A4 + European** generator (docx-js) with a clearly marked data block at the top and the document logic below. Output text is **English**; switch labels/locale if you need another language. They share one design system (Arial, a restrained accent colour, hairline rules) and bake in the fiddly parts: page size, DIN margins, dual table widths, `€1,234.56` formatting, page numbers.

| Template | File | Use for |
|----------|------|---------|
| Business letter (A4 / DIN 5008) | `assets/templates/letter-din5008.js` | A4 business letter — address field, info block, fold marks, footer |
| Report | `assets/templates/report.js` | Multi-page report — cover page, table of contents, headings, data tables, page numbers |
| Memo | `assets/templates/memo.js` | Short internal memo — To/From/Date/Subject header |
| Invoice / quote | `assets/templates/invoice.js` | Invoice/quote — line-item table, VAT breakdown, totals, payment details |

**Workflow:**
1. Copy the template to your working dir (keep the original intact): `cp assets/templates/invoice.js ./invoice.js`
2. Edit the `data = { … }` block at the top — that is normally the *only* part you change. Replace the placeholders ("Mustermann GmbH", recipient, line items, …) with the real content.
3. Run it: `node invoice.js output.docx`. Needs the `docx` package — if `require('docx')` cannot resolve a global install, run `NODE_PATH=$(npm root -g) node invoice.js output.docx` or `npm install docx` in the working dir first.
4. Validate: `python scripts/office/validate.py output.docx`.

These are ordinary docx-js scripts, so **adapt freely** — change the `ACCENT` constant for a brand colour, swap the font, add or remove sections. If the user has fixed company details or a logo, set them once in the template.

**Render target:** optimise for **Microsoft Word** and Word-compatible viewers (LibreOffice, Google Docs). Apple Pages renders `.docx` unreliably — it misplaces page-anchored frames (e.g. the letter's fold marks) and collapses paragraph spacing — so never judge output by Pages.

---

## Creating New Documents

Generate .docx files with JavaScript, then validate. Install: `npm install -g docx` (if a script's `require('docx')` can't find the global install, run it with `NODE_PATH=$(npm root -g) node script.js` or `npm install docx` locally).

### Setup
```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
        Header, Footer, AlignmentType, PageOrientation, LevelFormat, ExternalHyperlink,
        InternalHyperlink, Bookmark, FootnoteReferenceRun, PositionalTab,
        PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader,
        TabStopType, TabStopPosition, Column, SectionType,
        TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
        VerticalAlign, PageNumber, PageBreak } = require('docx');

const doc = new Document({ sections: [{ children: [/* content */] }] });
Packer.toBuffer(doc).then(buffer => fs.writeFileSync("doc.docx", buffer));
```

### Validation
After creating the file, validate it. If validation fails, unpack, fix the XML, and repack.
```bash
python scripts/office/validate.py doc.docx
```

### Page Size

Default to **A4** for European/German documents (docx-js already defaults to A4, but set it explicitly so the result is predictable). Use US Letter only when the document is specifically for a US audience.

```javascript
// A4 with metric margins. Conversions: 1 mm = 56.7 DXA, 1 cm = 567 DXA, 1 inch = 1440 DXA.
const mm = v => Math.round(v * 1440 / 25.4);  // handy metric helper -> mm(210), mm(25), ...
sections: [{
  properties: {
    page: {
      size: { width: 11906, height: 16838 },                      // A4: 210 × 297 mm
      margin: { top: mm(25), right: mm(20), bottom: mm(20), left: mm(25) } // DIN-style 2.5/2.0 cm
    }
  },
  children: [/* content */]
}]
```

**Common page sizes (DXA units):**

| Paper | Width | Height | Content width |
|-------|-------|--------|---------------|
| **A4 (default)** | 11,906 | 16,838 | 9,355 (2.5/2.0 cm margins) · 9,638 (2 cm all round) |
| US Letter | 12,240 | 15,840 | 9,360 (1" margins) |

**Landscape orientation:** docx-js swaps width/height internally, so pass portrait dimensions and let it handle the swap:
```javascript
size: {
  width: 12240,   // Pass SHORT edge as width
  height: 15840,  // Pass LONG edge as height
  orientation: PageOrientation.LANDSCAPE  // docx-js swaps them in the XML
},
// Content width = 15840 - left margin - right margin (uses the long edge)
```

### Non-ASCII / Internationalization

DOCX is UTF-8 internally and `docx-js` handles Unicode (Umlauts ÄÖÜß, accents, CJK) without extra configuration — pass strings as-is in `new TextRun("Universität München")`. The risks are at conversion boundaries, not inside docx-js itself:

- **Pandoc**: pass `--from=markdown+smart` and ensure source files are UTF-8. If you see mojibake (`Ã¤` for `ä`), the source was read as Latin-1 — re-read with explicit encoding.
- **LibreOffice (soffice)**: `--convert-to docx:"MS Word 2007 XML"` preserves UTF-8; the legacy `MS Word 97` filter does not. Always target the `.docx` filter for round-trips.
- **Reading source text in Python**: always `open(path, encoding="utf-8")`. Default encoding on Linux containers is UTF-8 but Windows hosts default to cp1252.
- **XML emergency entities** (for unpacked editing when a character won't round-trip): `&#196;` Ä · `&#214;` Ö · `&#220;` Ü · `&#228;` ä · `&#246;` ö · `&#252;` ü · `&#223;` ß
- **Arial covers** Latin-1, Latin-Extended-A, and common diacritics. For CJK, Cyrillic, or Greek output, switch to a font with the required coverage (e.g. "Noto Sans", "DejaVu Sans") rather than relying on Arial.

### European Conventions

The bundled templates default to A4 + euro and produce **English** text. Apply these (or adjust the locale for another language):

- **Dates**: write the month in letters in headings/covers/letters — `1 June 2026`. For tables/metadata, ISO `2026-06-01` is unambiguous.
  ```javascript
  const M = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dateLong = d => `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()}`;
  ```
- **Currency & numbers**: use `Intl` (Node ships full ICU). For euro amounts in English, `en-GB` gives `€1,234.56`:
  ```javascript
  const eur = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" });
  eur.format(1234.5); // "€1,234.50"
  ```
- **Address**: name / street + number / postal code + city, each on its own line (one Paragraph each — never `\n`).
- **VAT**: label it `VAT`; standard German rate 19 %, reduced 7 %. Small-business exemption: `Exempt from VAT under the small-business rule (§ 19 UStG).`
- **German output** (if ever needed): switch to the `de-DE` locale (`1.234,56 €`), German month names (`1. Juni 2026`), and German quotation marks `„…"` / `»…«` instead of `"…"`.

### Styles (Override Built-in Headings)

Use Arial as the default font (universally supported for Latin scripts including Umlauts and common European diacritics). Keep titles black for readability.

```javascript
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } }, // 12pt default
    paragraphStyles: [
      // IMPORTANT: Use exact IDs to override built-in styles
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } }, // outlineLevel required for TOC
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Title")] }),
    ]
  }]
});
```

### Lists (NEVER use unicode bullets)

```javascript
// ❌ WRONG - never manually insert bullet characters
new Paragraph({ children: [new TextRun("• Item")] })  // BAD
new Paragraph({ children: [new TextRun("\u2022 Item")] })  // BAD

// ✅ CORRECT - use numbering config with LevelFormat.BULLET
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 },
        children: [new TextRun("Bullet item")] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 },
        children: [new TextRun("Numbered item")] }),
    ]
  }]
});

// ⚠️ Each reference creates INDEPENDENT numbering
// Same reference = continues (1,2,3 then 4,5,6)
// Different reference = restarts (1,2,3 then 1,2,3)
```

### Tables

**CRITICAL: Tables need dual widths** - set both `columnWidths` on the table AND `width` on each cell. Without both, tables render incorrectly on some platforms.

```javascript
// CRITICAL: Always set table width for consistent rendering
// CRITICAL: Use ShadingType.CLEAR (not SOLID) to prevent black backgrounds
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
  width: { size: 9360, type: WidthType.DXA }, // Always use DXA (percentages break in Google Docs)
  columnWidths: [4680, 4680], // Must sum to table width (DXA: 1440 = 1 inch)
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 4680, type: WidthType.DXA }, // Also set on each cell
          shading: { fill: "D5E8F0", type: ShadingType.CLEAR }, // CLEAR not SOLID
          margins: { top: 80, bottom: 80, left: 120, right: 120 }, // Cell padding (internal, not added to width)
          children: [new Paragraph({ children: [new TextRun("Cell")] })]
        })
      ]
    })
  ]
})
```

**Table width calculation:**

Always use `WidthType.DXA` — `WidthType.PERCENTAGE` breaks in Google Docs.

```javascript
// Table width = sum of columnWidths = content width
// US Letter with 1" margins: 12240 - 2880 = 9360 DXA
width: { size: 9360, type: WidthType.DXA },
columnWidths: [7000, 2360]  // Must sum to table width
```

**Width rules:**
- **Always use `WidthType.DXA`** — never `WidthType.PERCENTAGE` (incompatible with Google Docs)
- Table width must equal the sum of `columnWidths`
- Cell `width` must match corresponding `columnWidth`
- Cell `margins` are internal padding - they reduce content area, not add to cell width
- For full-width tables: use content width (page width minus left and right margins)

### Images

```javascript
// CRITICAL: type parameter is REQUIRED
new Paragraph({
  children: [new ImageRun({
    type: "png", // Required: png, jpg, jpeg, gif, bmp, svg
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "Title", description: "Desc", name: "Name" } // All three required
  })]
})
```

### Page Breaks

```javascript
// CRITICAL: PageBreak must be inside a Paragraph
new Paragraph({ children: [new PageBreak()] })

// Or use pageBreakBefore
new Paragraph({ pageBreakBefore: true, children: [new TextRun("New page")] })
```

### Hyperlinks

```javascript
// External link
new Paragraph({
  children: [new ExternalHyperlink({
    children: [new TextRun({ text: "Click here", style: "Hyperlink" })],
    link: "https://example.com",
  })]
})

// Internal link (bookmark + reference)
// 1. Create bookmark at destination
new Paragraph({ heading: HeadingLevel.HEADING_1, children: [
  new Bookmark({ id: "chapter1", children: [new TextRun("Chapter 1")] }),
]})
// 2. Link to it
new Paragraph({ children: [new InternalHyperlink({
  children: [new TextRun({ text: "See Chapter 1", style: "Hyperlink" })],
  anchor: "chapter1",
})]})
```

### Footnotes

```javascript
const doc = new Document({
  footnotes: {
    1: { children: [new Paragraph("Source: Annual Report 2024")] },
    2: { children: [new Paragraph("See appendix for methodology")] },
  },
  sections: [{
    children: [new Paragraph({
      children: [
        new TextRun("Revenue grew 15%"),
        new FootnoteReferenceRun(1),
        new TextRun(" using adjusted metrics"),
        new FootnoteReferenceRun(2),
      ],
    })]
  }]
});
```

### Tab Stops

```javascript
// Right-align text on same line (e.g., date opposite a title)
new Paragraph({
  children: [
    new TextRun("Company Name"),
    new TextRun("\tJanuary 2025"),
  ],
  tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
})

// Dot leader (e.g., TOC-style)
new Paragraph({
  children: [
    new TextRun("Introduction"),
    new TextRun({ children: [
      new PositionalTab({
        alignment: PositionalTabAlignment.RIGHT,
        relativeTo: PositionalTabRelativeTo.MARGIN,
        leader: PositionalTabLeader.DOT,
      }),
      "3",
    ]}),
  ],
})
```

### Multi-Column Layouts

```javascript
// Equal-width columns
sections: [{
  properties: {
    column: {
      count: 2,          // number of columns
      space: 720,        // gap between columns in DXA (720 = 0.5 inch)
      equalWidth: true,
      separate: true,    // vertical line between columns
    },
  },
  children: [/* content flows naturally across columns */]
}]

// Custom-width columns (equalWidth must be false)
sections: [{
  properties: {
    column: {
      equalWidth: false,
      children: [
        new Column({ width: 5400, space: 720 }),
        new Column({ width: 3240 }),
      ],
    },
  },
  children: [/* content */]
}]
```

Force a column break with a new section using `type: SectionType.NEXT_COLUMN`.

### Table of Contents

```javascript
// CRITICAL: Headings must use HeadingLevel ONLY - no custom styles
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })
```

### Headers/Footers

```javascript
sections: [{
  properties: {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } // 1440 = 1 inch
  },
  headers: {
    default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] })
  },
  footers: {
    default: new Footer({ children: [new Paragraph({
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })]
    })] })
  },
  children: [/* content */]
}]
```

### Critical Rules for docx-js

- **Set page size explicitly** - default to A4 (11906 x 16838 DXA) for European documents; use US Letter (12240 x 15840) only for a US audience
- **Landscape: pass portrait dimensions** - docx-js swaps width/height internally; pass short edge as `width`, long edge as `height`, and set `orientation: PageOrientation.LANDSCAPE`
- **Never use `\n`** - use separate Paragraph elements
- **Never use unicode bullets** - use `LevelFormat.BULLET` with numbering config
- **PageBreak must be in Paragraph** - standalone creates invalid XML
- **ImageRun requires `type`** - always specify png/jpg/etc
- **Always set table `width` with DXA** - never use `WidthType.PERCENTAGE` (breaks in Google Docs)
- **Tables need dual widths** - `columnWidths` array AND cell `width`, both must match
- **Table width = sum of columnWidths** - for DXA, ensure they add up exactly
- **Always add cell margins** - use `margins: { top: 80, bottom: 80, left: 120, right: 120 }` for readable padding
- **Use `ShadingType.CLEAR`** - never SOLID for table shading
- **Never use tables as dividers/rules** - cells have minimum height and render as empty boxes (including in headers/footers); use `border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "2E75B6", space: 1 } }` on a Paragraph instead. For two-column footers, use tab stops (see Tab Stops section), not tables
- **TOC requires HeadingLevel only** - no custom styles on heading paragraphs
- **Override built-in styles** - use exact IDs: "Heading1", "Heading2", etc.
- **Include `outlineLevel`** - required for TOC (0 for H1, 1 for H2, etc.)

---

## Editing Existing Documents

To modify an existing `.docx` (rather than generate a new one): unpack to XML -> edit -> repack.

```bash
python scripts/office/unpack.py document.docx unpacked/                       # extract + pretty-print XML
# edit files in unpacked/word/ with the Edit tool (string replacement; don't write Python)
python scripts/office/pack.py unpacked/ output.docx --original document.docx  # validate + repack
```

Use **"Claude"** as the author for tracked changes and comments unless told otherwise. Before editing, **read `references/editing-existing-docx.md`** — it has the full workflow plus the exact XML for tracked changes (insert/delete/reject/restore), comments, smart/German quotes, and embedding images. Those rules are strict and easy to get wrong by guessing.

---

## Dependencies

- **pandoc**: Text extraction
- **docx** (npm): document generation — usually already pre-installed; otherwise `npm install -g docx`
- **LibreOffice**: PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- **Poppler**: `pdftoppm` for images
- **Python**: `defusedxml` + `lxml` — required by unpack / pack / validate / comment
