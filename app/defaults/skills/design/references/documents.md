# Documents Reference

Reports, documents, data visualizations, print/PDF output. This is where clarity and structure carry the design.

---

## Type Scale

Use Major Second (1.125) for dense documents, Minor Third (1.200) for reports with clear section breaks.

- For 11pt base with 1.125: **11, 12.4, 13.9, 15.7, 17.6pt**
- For 12pt base with 1.200: **12, 14.4, 17.3, 20.7, 24.9pt**

---

## Typography for Documents

Document typography differs from screen typography. Reading sustained text demands different choices.

- **Base size:** 11-12pt minimum for print, 16-18px for screen documents
- **Line height:** 1.5-1.6× for body text, 1.1-1.2× for headings. AI often applies uniform line-height — don't.
- **Line length:** Maximum **70 characters** (60-80 range). For 12pt font, this means ~5-5.5 inches text block width.
- **Serif consideration** — serif typefaces often improve readability in long-form printed text. Sans-serif works well for screen documents and shorter content.
- **Heading scale** — 3-4 levels maximum. Each visually distinct through size, weight, AND spacing — not just size. Over-nesting (H5, H6) signals structural problems.
- **Paragraph spacing:** Use EITHER indentation (first-line indent 0.25-0.5 inch, no space between) OR block spacing (8-12pt space after, no indent). **Never both.** AI frequently applies both.
- **Two typefaces maximum.** Three is noise in a document context.
- **2-3 font weights maximum.** Regular for body, semibold for headings, maybe bold for emphasis. Professional documents don't use the full weight spectrum.

---

## Page Structure

Documents have physical constraints that screens don't. Design for them.

- **Margins (asymmetric by design):**
  - Inside (gutter): 1 inch
  - Outside: 0.75 inch
  - Top: 1 inch
  - Bottom: 1.25 inch
- **Headers and footers** — consistent placement of page numbers, document title, date, section name. These are wayfinding, not decoration.
- **Section breaks** — visual rhythm in long-form content prevents fatigue. Use whitespace, horizontal rules, or section headers for pacing.
- **Cover page** — title, subtitle, author, date, one strong visual element. Resist the urge to fill every inch.

---

## Color

- **2-3 colors maximum.** One for body text (near-black like `#1A1A2E` or `#2D3436`), one accent for headings or rules, one for subtle backgrounds on callouts.
- **Never pure black body text.** Always tint slightly warm or cool.
- **Add <5% saturation** to neutrals in HSB. Commit to warm or cool — never mix both.
- **Horizontal rules instead of thick borders.** A 0.5pt line in mid-grey (`#CCCCCC`) separates sections elegantly. AI tends to use heavy borders.

---

## Data Visualization

Charts and tables are the reason documents exist. Design them like first-class citizens.

### Chart Selection

Choose the chart that serves the story, not the one that's easiest to make:

- **Comparison** — bar charts (horizontal for many items, vertical for few)
- **Trend over time** — line charts (single or multi-series)
- **Part of whole** — stacked bar or treemap (avoid pie charts unless ≤4 segments)
- **Distribution** — histogram, box plot, or density
- **Relationship** — scatter plot, bubble chart
- **Geographic** — choropleth, dot density

### Color in Charts

- Use your document palette, not random defaults. Chart colors should belong to the document.
- **Maximum 6 distinct colors** in any single visualization.
- Use a single highlight color to call attention to the key data point — grey everything else (Von Restorff Effect).
- Provide pattern fills or labels as alternatives to color-only encoding for accessibility.
- For sequential data, use light-to-dark of one hue. For categories, use distinct hues at similar saturation/brightness.

### Table Styling

Tables are reading interfaces, not data dumps.

- **Align numbers right** — decimal points line up, comparisons become instant
- **Align text left** — natural reading direction
- **No vertical rules.** Light horizontal rules only (0.5pt). Header row: bold with 1pt bottom border.
- **Zebra striping with restraint** — barely-there alternating rows, not dramatic bands
- **Whitespace in cells** — generous padding prevents the "spreadsheet export" look
- **Data table text: 12-14px**, not the body text size

---

## Executive Summary Layout

The first page after the cover often determines whether the rest gets read.

- **Key metrics up front** — 3-5 headline numbers with context, not just values
- **One-paragraph overview** — the entire document's conclusion in 3-4 sentences
- **Visual anchor** — one chart or diagram that captures the main story
- **Clear navigation** — what's in this document and where to find it

---

## Visual Rhythm

Long documents need pacing. Unbroken walls of text lose readers.

- **Alternate text and visual** — every 2-3 pages should have a chart, diagram, table, or image
- **Pull quotes or callout boxes** — highlight key findings inline. Set in slightly larger size with a subtle left border (3pt, accent color).
- **Margin notes** — secondary context that doesn't interrupt the main flow
- **Chapter/section openers** — distinct visual treatment marks transitions
- **Consistent heading numbering** (1, 1.1, 1.1.1) for professional documents

---

## Chart Implementation

When building charts in HTML/CSS/SVG:

- **SVG for vector charts.** Line charts, bar charts, area charts — always SVG. They scale perfectly for print and screen.
- **Keep SVG concise.** Define reusable elements with `<defs>` and reference with `<use>`. Don't repeat gradient definitions.
- **Axis labels matter more than gridlines.** Label key data points directly on the chart (annotation) rather than relying on axis + gridline reading. Direct labels reduce cognitive load.
- **Responsive SVG:** Use `viewBox` and `preserveAspectRatio`. Never hardcode pixel widths.
- **Animation in charts:** Only for screen documents. Use CSS transitions on bar heights or line drawing (`stroke-dashoffset` technique).

**Chart typography:**
- Axis labels: 10-11px, secondary text color
- Data labels: 11-12px, primary text color, `font-variant-numeric: tabular-nums`
- Chart title: same as document H3
- Source/footnote: 9-10px, muted text color

---

## Print Considerations

If the document might be printed:

- **CMYK-safe colors** — vibrant screen blues and greens shift when printed. Test or use established print-safe palettes.
- **Minimum line weight** — hairline rules disappear on some printers. 0.5pt minimum.
- **Image resolution** — 300dpi for photos, vector for charts and diagrams
- **Bleed awareness** — content near page edges risks being cut. Keep critical content within safe margins.
- **Optical margin alignment** — punctuation marks near edges should extend slightly past the text block for visual alignment

---

## What AI Gets Wrong in Documents

- Uses decorative elements that undermine seriousness
- Applies web conventions (cards, shadows, rounded corners) to print contexts
- Makes headings too large relative to body text
- Ignores typographic details: hyphenation, orphans, widows
- Both indents AND block spacing between paragraphs (pick one)
- Dead-neutral greys instead of tinted neutrals
- Heavy borders instead of subtle rules
