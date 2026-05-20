---
name: document-parse
description: Use this skill when the user asks to parse, perform multi-format document conversion or when you want to spatially extract text from an unstructured file (PDF, DOCX, PPTX, XLSX, images, etc.).
---

# Document to Text

Parse unstructured documents (PDF, DOCX, PPTX, XLSX, images, and more) locally with LiteParse (fast local OCR).

## Parse a Single File

```bash
# Basic text extraction
lit parse document.pdf

# JSON output saved to a file
lit parse document.pdf --format json -o output.json

# Specific page range
lit parse document.pdf --target-pages "1-5,10,15-20"

# Disable OCR (faster, text-only PDFs)
lit parse document.pdf --no-ocr

# Use an external HTTP OCR server for higher accuracy
lit parse document.pdf --ocr-server-url http://localhost:8828/ocr

# Higher DPI for better quality
lit parse document.pdf --dpi 300
```

## Batch Parse a Directory

```bash
lit batch-parse ./input-directory ./output-directory

# Only process PDFs, recursively
lit batch-parse ./input ./output --extension .pdf --recursive
```

## Generate Page Screenshots

Screenshots are useful for LLM agents that need to see visual layout or to extract pages as screenshots.

```bash
# All pages
lit screenshot document.pdf -o ./screenshots

# Specific pages
lit screenshot document.pdf --pages "1,3,5" -o ./screenshots

# High-DPI PNG
lit screenshot document.pdf --dpi 300 --format png -o ./screenshots

# Page range
lit screenshot document.pdf --pages "1-10" -o ./screenshots
```

---

## Key Options Reference

### OCR Options

| Option | Description |
|--------|-------------|
| (default) | Tesseract.js — zero setup, built-in |
| `--ocr-language fra` | Set OCR language (ISO code) |
| `--ocr-server-url <url>` | Use external HTTP OCR server (EasyOCR, PaddleOCR, custom) |
| `--no-ocr` | Disable OCR entirely |

### Output Options

| Option | Description |
|--------|-------------|
| `--format json` | Structured JSON with bounding boxes |
| `--format text` | Plain text (default) |
| `-o <file>` | Save output to file |

### Performance / Quality Options

| Option | Description |
|--------|-------------|
| `--dpi <n>` | Rendering DPI (default: 150; use 300 for high quality) |
| `--max-pages <n>` | Limit pages parsed |
| `--target-pages <pages>` | Parse specific pages (e.g. `"1-5,10"`) |
| `--no-precise-bbox` | Disable precise bounding boxes (faster) |
| `--skip-diagonal-text` | Ignore rotated/diagonal text |
| `--preserve-small-text` | Keep very small text that would otherwise be dropped |

## Repeated Use: Using a Config File

For repeated use with consistent options, generate a `liteparse.config.json`:

```json
{
  "ocrLanguage": "en",
  "ocrEnabled": true,
  "maxPages": 1000,
  "dpi": 150,
  "outputFormat": "json",
  "preciseBoundingBox": true,
  "skipDiagonalText": false,
  "preserveVerySmallText": false
}
```

Use with:

```bash
lit parse document.pdf --config liteparse.config.json
```

---

## Non-ASCII / Internationalization

OCR is the main source of Umlaut/diacritic corruption — Tesseract defaults to English and will misread `ä` as `a` or `ö` as `6`. Always set the language explicitly for non-English documents:

```bash
# Single language
lit parse vertrag.pdf --ocr-language deu

# Multiple languages (e.g. German + English in one document)
lit parse mixed.pdf --ocr-language "deu+eng"
```

Common ISO codes: `deu` (German), `fra` (French), `spa` (Spanish), `ita` (Italian), `por` (Portuguese), `nld` (Dutch), `pol` (Polish), `rus` (Russian), `jpn` (Japanese), `chi_sim`/`chi_tra` (Chinese). For higher accuracy on Umlaut-heavy material, route to a stronger backend via `--ocr-server-url` (PaddleOCR, EasyOCR).

**Reading the output**: `lit` writes UTF-8. When loading the result in Python use `open(path, encoding="utf-8")` — never rely on the platform default. If you see `Ã¤` / `Ã¶` / `Ã¼` in output, the file was decoded as Latin-1; re-read with explicit UTF-8.

**Embedded text PDFs**: `--no-ocr` skips OCR entirely and pulls the embedded text layer, which is already correctly encoded — preferred when the PDF is digital-native.

## Supported Input Formats

| Category | Formats |
|----------|---------|
| PDF | `.pdf` |
| Word | `.doc`, `.docx`, `.docm`, `.odt`, `.rtf` |
| PowerPoint | `.ppt`, `.pptx`, `.pptm`, `.odp` |
| Spreadsheets | `.xls`, `.xlsx`, `.xlsm`, `.ods`, `.csv`, `.tsv` |
| Images | `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.tiff`, `.webp`, `.svg` |

LiteParse auto-converts these formats to PDF before parsing.
