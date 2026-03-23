---
name: documents
description: Generate PDFs, DOCX files, and other documents using Typst, Pandoc, and Playwright.
---

# Document Generation

## Quick Reference

| Scenario | Tool | Command |
|----------|------|---------|
| PDF from scratch (invoices, letters, reports) | Typst | `typst compile doc.typ output.pdf` |
| Markdown to PDF | Pandoc + Typst | `pandoc input.md -o output.pdf --pdf-engine=typst` |
| Markdown to DOCX | Pandoc | `pandoc input.md -o output.docx` |
| HTML to PDF (complex web layouts) | Playwright | `browser_pdf_save` or scripted `page.pdf()` |
| Format conversion (DOCX, EPUB, HTML, etc.) | Pandoc | `pandoc input.X -o output.Y` |

Save all generated files to `~/output/`. Save reusable templates to `~/templates/`.

---

## Typst (Recommended for PDFs)

Typst is the primary tool for generating PDFs. It compiles `.typ` files to PDF with excellent typography, tables, and layout control.

### Basic Usage

```bash
typst compile document.typ ~/output/document.pdf
```

### Markup Syntax Reference

| Element | Syntax |
|---------|--------|
| Heading 1 | `= Heading` |
| Heading 2 | `== Heading` |
| Heading 3 | `=== Heading` |
| Bold | `*bold text*` |
| Italic | `_italic text_` |
| Link | `#link("https://example.com")[Label]` |
| Unordered list | `- Item` |
| Ordered list | `+ Item` |
| Code inline | `` `code` `` |
| Code block | `` ```lang ... ``` `` |
| Image | `#image("path.png", width: 50%)` |
| Page break | `#pagebreak()` |
| Horizontal rule | `#line(length: 100%)` |

### Page Setup

```typst
#set page(paper: "a4", margin: (x: 2cm, y: 2.5cm))
#set text(font: "Linux Libertine", size: 11pt, lang: "en")
#set par(justify: true, leading: 0.65em)
```

### Templates

Ready-to-use Typst templates in `references/`:
- **`invoice.md`** — line items table, tax calculation, payment details
- **`letter.md`** — sender/recipient, subject, body, signature
- **`report.md`** — title page, table of contents, page numbers, headers

---

## Pandoc (Format Conversion)

Pandoc converts between document formats. Most useful for Markdown to DOCX or using Markdown as a simpler input for PDFs.

### Markdown to PDF (via Typst)

```bash
pandoc input.md -o ~/output/document.pdf --pdf-engine=typst
```

With custom Typst template:

```bash
pandoc input.md -o ~/output/document.pdf --pdf-engine=typst --template=~/templates/report.typst
```

### Markdown to DOCX

```bash
pandoc input.md -o ~/output/document.docx
```

With a reference document for styling (fonts, heading styles, margins):

```bash
pandoc input.md -o ~/output/document.docx --reference-doc=~/templates/reference.docx
```

To create a reference doc, generate a default one and edit it in a word processor:

```bash
pandoc -o ~/templates/reference.docx --print-default-data-file reference.docx
```

### Other Useful Conversions

```bash
# DOCX to Markdown
pandoc input.docx -o output.md

# Markdown to HTML
pandoc input.md -o output.html --standalone

# HTML to Markdown
pandoc input.html -o output.md

# EPUB generation
pandoc input.md -o output.epub --metadata title="My Book"
```

---

## Playwright (HTML to PDF)

For complex layouts that need CSS styling or rendering of web content, use the Playwright browser (already installed).

### Using the MCP Tool

The simplest approach for single pages:

```
browser_navigate(url="file:///home/atlas/output/report.html")
browser_pdf_save(filename="report.pdf")
```

### Scripted Approach

For more control, write a quick Node.js script:

```javascript
// ~/helpers/html-to-pdf.mjs
import { chromium } from 'playwright';

const [input, output] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${input}`, { waitUntil: 'networkidle' });
await page.pdf({
  path: output,
  format: 'A4',
  margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' },
  printBackground: true,
});
await browser.close();
```

```bash
node ~/helpers/html-to-pdf.mjs /home/atlas/output/report.html /home/atlas/output/report.pdf
```

---

## Best Practices

- **Output directory**: Always save generated files to `~/output/` so they can be easily shared or attached.
- **Templates**: Save reusable `.typ` templates to `~/templates/` for consistent formatting across documents.
- **Typst first**: Prefer Typst for PDF generation. It is fast, produces high-quality output, and has a simple syntax. Use Pandoc mainly for format conversion or when the source is already Markdown. Use Playwright only when CSS rendering fidelity matters.
- **Localization**: Set `#set text(lang: "de")` (or other language code) in Typst for correct hyphenation. Use `#set page(paper: "a4")` for standard European page size, or `"us-letter"` for US.
- **Fonts**: The container ships with standard system fonts. Typst also bundles its own fonts. To list available fonts: `typst fonts`.
