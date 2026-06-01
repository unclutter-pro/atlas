// Report — A4, cover page + table of contents + chapters. English, European conventions.
// Standalone docx-js generator. Edit the `data` block, then: node report.js [out.docx]
// NOTE: The table of contents shows page numbers only after Word/LibreOffice updates fields
//       (open the file, then "Update Table" / update fields). This is normal for docx.
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, TabStopType, WidthType, BorderStyle, ShadingType, HeadingLevel,
  TableOfContents, Header, Footer, PageNumber, PageBreak, LevelFormat,
} = require("docx");

// ---------- unit + locale helpers ----------
const mm = v => Math.round(v * 1440 / 25.4);
const S  = pt => Math.round(pt * 2);
const MONTHS = ["January","February","March","April","May","June","July","August",
                "September","October","November","December"];
const dateLong = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

// ---------- theme ----------
const FONT   = "Arial";
const ACCENT = "1F3A5F";
const INK    = "1A1A1A";
const MUTED  = "6B7682";
const HAIR   = "C7D0D9";
const PANEL  = "EEF2F6"; // light panel fill

const PAGE = { width: mm(210), height: mm(297) };
const MARGIN = { top: mm(25), right: mm(25), bottom: mm(20), left: mm(25) };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right; // 160mm

// ====== EDIT YOUR DATA HERE ======
const data = {
  org: "Example Ltd",
  title: "Digital Strategy 2026",
  subtitle: "Analysis, roadmap and recommendations",
  author: "John Sample",
  place: "Sample City",
  date: new Date(2026, 5, 1),
  chapters: [
    { h: "Summary", body: [
      "This report summarises the findings of the as-is analysis and derives a roadmap for the digital transformation. The key areas for action are prioritised and backed with concrete measures.",
    ]},
    { h: "Background", body: [
      "The existing system landscape has grown historically and is partly heterogeneous. Media discontinuities between departments cause manual overhead.",
    ], sub: [
      { h: "System landscape", body: ["The core processes are currently handled across three non-integrated systems."] },
      { h: "Data quality", body: ["Master data is maintained in several places, which leads to inconsistencies."] },
    ]},
    { h: "Recommendations", body: [
      "The analysis yields the following prioritised measures:",
    ], bullets: [
      "Introduce central master-data management",
      "Phase out the legacy systems step by step",
      "Build a KPI dashboard for management",
    ], table: {
      head: ["Measure", "Priority", "Timeframe"],
      rows: [
        ["Master-data management", "High", "Q3 2026"],
        ["Legacy system phase-out", "Medium", "2027"],
        ["KPI dashboard", "High", "Q4 2026"],
      ],
    }},
  ],
};
// ========================================================

const styles = {
  default: { document: { run: { font: FONT, size: S(11), color: INK } } },
  paragraphStyles: [
    { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: S(17), bold: true, color: ACCENT, font: FONT },
      paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: HAIR, space: 6 } } } },
    { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: S(13), bold: true, color: INK, font: FONT },
      paragraph: { spacing: { before: 240, after: 100 }, outlineLevel: 1 } },
    { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
      run: { size: S(11.5), bold: true, color: MUTED, font: FONT },
      paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 2 } },
  ],
};

const numbering = { config: [{ reference: "rep-bullets", levels: [
  { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
    style: { run: { color: ACCENT }, paragraph: { indent: { left: mm(8), hanging: mm(5) } } } },
]}]};

const body = (text) => new Paragraph({ spacing: { after: 160, line: 288 }, children: [new TextRun({ text, size: S(11) })] });
const bullet = (text) => new Paragraph({ numbering: { reference: "rep-bullets", level: 0 }, spacing: { after: 60, line: 276 }, children: [new TextRun({ text, size: S(11) })] });

// Data table with correct dual widths + clean shading
function dataTable(t) {
  const cols = t.head.length;
  const colW = Math.floor(CONTENT_W / cols);
  const widths = Array(cols).fill(colW);
  widths[cols - 1] = CONTENT_W - colW * (cols - 1);
  const row = (cells, opts = {}) => new TableRow({
    tableHeader: !!opts.head,
    children: cells.map((c, i) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      shading: opts.head ? { fill: ACCENT, type: ShadingType.CLEAR, color: "auto" }
             : opts.zebra ? { fill: PANEL, type: ShadingType.CLEAR, color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 120, right: 120 },
      borders: { bottom: { style: BorderStyle.SINGLE, size: 2, color: HAIR } },
      children: [new Paragraph({ children: [new TextRun({ text: c, size: S(10.5), bold: !!opts.head, color: opts.head ? "FFFFFF" : INK })] })],
    })),
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths,
    rows: [row(t.head, { head: true }), ...t.rows.map((r, i) => row(r, { zebra: i % 2 === 1 }))],
  });
}

// ---------- cover page (section 1) ----------
const cover = {
  properties: { page: { size: PAGE, margin: { top: mm(45), right: mm(25), bottom: mm(25), left: mm(25) } } },
  children: [
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: data.org.toUpperCase(), size: S(11), bold: true, color: MUTED, characterSpacing: 30 })] }),
    new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 1 } }, spacing: { after: 600, line: 1 }, children: [new TextRun({ text: "", size: S(1) })] }),
    new Paragraph({ spacing: { before: 1200, after: 160 }, children: [new TextRun({ text: data.title, size: S(30), bold: true, color: ACCENT })] }),
    new Paragraph({ spacing: { after: 1600 }, children: [new TextRun({ text: data.subtitle, size: S(15), color: INK })] }),
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: data.author, size: S(11), bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: `${data.place}, ${dateLong(data.date)}`, size: S(11), color: MUTED })] }),
  ],
};

// ---------- content section (section 2) ----------
const contentChildren = [
  new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "Table of Contents", size: S(17), bold: true, color: ACCENT })] }),
  new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
  new Paragraph({ children: [new PageBreak()] }),
];
for (const ch of data.chapters) {
  contentChildren.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(ch.h)] }));
  (ch.body || []).forEach(p => contentChildren.push(body(p)));
  (ch.bullets || []).forEach(b => contentChildren.push(bullet(b)));
  if (ch.table) { contentChildren.push(dataTable(ch.table)); contentChildren.push(new Paragraph({ spacing: { after: 120 }, children: [] })); }
  (ch.sub || []).forEach(s => {
    contentChildren.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(s.h)] }));
    (s.body || []).forEach(p => contentChildren.push(body(p)));
  });
}

const content = {
  properties: { page: { size: PAGE, margin: MARGIN, pageNumbers: { start: 1 } } },
  headers: { default: new Header({ children: [new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: HAIR, space: 4 } },
    children: [
      new TextRun({ text: data.title, size: S(8.5), color: MUTED }),
      new TextRun({ text: "\t" + data.org, size: S(8.5), color: MUTED }),
    ],
  })] }) },
  footers: { default: new Footer({ children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: HAIR, space: 4 } },
    children: [
      new TextRun({ text: "Page ", size: S(8.5), color: MUTED }),
      new TextRun({ children: [PageNumber.CURRENT], size: S(8.5), color: MUTED }),
      new TextRun({ text: " of ", size: S(8.5), color: MUTED }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], size: S(8.5), color: MUTED }),
    ],
  })] }) },
  children: contentChildren,
};

const doc = new Document({ styles, numbering, features: { updateFields: true }, sections: [cover, content] });
const out = process.argv[2] || "report.docx";
Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log("written:", out); });
