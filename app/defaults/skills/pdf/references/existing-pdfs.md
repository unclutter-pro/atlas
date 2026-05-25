# Working with Existing PDFs

Operations on PDFs that already exist: merge, split, rotate, watermark, encrypt, render to images. For reading text or running OCR use the `document-parse` skill. For filling fillable PDF forms use [forms.md](forms.md).

**Default toolchain**: `qpdf` (CLI, structural ops) + `pypdf` (Python, in-memory page manipulation). Both are pre-installed in the container. Don't reach for pdf-lib, reportlab, or pdfjs-dist — they aren't part of this skill.

## Merge

```bash
# Concatenate full files
qpdf --empty --pages a.pdf b.pdf c.pdf -- merged.pdf

# Concatenate specific pages from different files
qpdf --empty --pages doc1.pdf 1-3 doc2.pdf 5-7 doc3.pdf 2,4 -- combined.pdf
```

Python equivalent (use when you already have `PdfReader` objects in memory):

```python
from pypdf import PdfWriter
w = PdfWriter()
for path in ["a.pdf", "b.pdf"]:
    w.append(path)
w.write("merged.pdf")
```

## Split / extract pages

```bash
# Every page as its own file
qpdf --split-pages=1 input.pdf out_%d.pdf

# Page range
qpdf input.pdf --pages input.pdf 1,3-5,8,10-end -- subset.pdf
```

## Rotate

```bash
# Rotate pages 2 through 4 by 90° clockwise
qpdf --rotate=+90:2-4 input.pdf rotated.pdf

# Rotate all pages 180°
qpdf --rotate=180 input.pdf rotated.pdf
```

## Watermark / overlay

```bash
# Stamp every page with a watermark.pdf
qpdf input.pdf --overlay watermark.pdf -- watermarked.pdf

# Background instead of overlay (watermark.pdf behind the content)
qpdf input.pdf --underlay watermark.pdf -- watermarked.pdf
```

The watermark file is itself a PDF — generate one with the `build-pdf` route or via Typst:

```typst
#set page(width: 21cm, height: 29.7cm, margin: 0pt)
#align(center + horizon)[
  #rotate(-30deg, text(size: 100pt, fill: rgb("#0001"))[VERTRAULICH])
]
```

## Encrypt / decrypt

```bash
# Password-protect with separate user and owner passwords
qpdf --encrypt user_pass owner_pass 256 --print=none --modify=none -- input.pdf encrypted.pdf

# Inspect the encryption state
qpdf --show-encryption encrypted.pdf

# Remove encryption (requires the password)
qpdf --password=secret123 --decrypt encrypted.pdf decrypted.pdf
```

## Repair and inspect

```bash
# Check for structural issues
qpdf --check input.pdf

# Try to repair a damaged PDF
qpdf --replace-input damaged.pdf

# Optimize for web (linearize)
qpdf --linearize input.pdf optimized.pdf
```

## Render PDF pages to images

For form-filling validation, debug rasterization, or generating page previews use **`pypdfium2`** (PDFium binding, fast and accurate):

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("document.pdf")
for i, page in enumerate(pdf):
    img = page.render(scale=2.0).to_pil()
    img.save(f"page_{i+1}.png")
```

For a quick CLI render, `pdftoppm` from poppler-utils works too:

```bash
pdftoppm -png -r 200 document.pdf out_prefix          # all pages
pdftoppm -png -r 300 -f 1 -l 3 document.pdf hi_res    # pages 1-3, 300 DPI
```

## Crop a page

```python
from pypdf import PdfReader, PdfWriter

r = PdfReader("input.pdf")
w = PdfWriter()
page = r.pages[0]
page.mediabox.lower_left  = (50, 50)
page.mediabox.upper_right = (550, 750)
w.add_page(page)
with open("cropped.pdf", "wb") as f:
    w.write(f)
```

## Troubleshooting

**Encrypted input**

```python
from pypdf import PdfReader
r = PdfReader("encrypted.pdf")
if r.is_encrypted:
    r.decrypt("password")
```

**Empty text extraction** — scanned/image-only PDF. Don't try harder here, switch to the `document-parse` skill (LiteParse with OCR).

**Corrupted file** — `qpdf --check input.pdf` reports concretely what's broken; `qpdf --replace-input damaged.pdf` rebuilds the structure.

## See also

- [forms.md](forms.md) — filling fillable PDF forms
- `document-parse` skill — reading text, OCR, structure extraction
- qpdf docs: <https://qpdf.readthedocs.io/>
- pypdf docs: <https://pypdf.readthedocs.io/>
