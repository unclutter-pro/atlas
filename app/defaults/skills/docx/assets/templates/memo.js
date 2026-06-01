// Memo — A4, compact internal memo. English, European conventions.
// Standalone docx-js generator. Edit the `data` block, then: node memo.js [out.docx]
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle, VerticalAlign, LevelFormat,
  Header, Footer, PageNumber,
} = require("docx");

// ---------- unit + locale helpers ----------
const mm = v => Math.round(v * 1440 / 25.4);
const S  = pt => Math.round(pt * 2);
const MONTHS = ["January","February","March","April","May","June","July","August",
                "September","October","November","December"];
const dateLong = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

// ---------- theme ----------
const FONT = "Arial";
const ACCENT = "1F3A5F";
const INK = "1A1A1A";
const MUTED = "6B7682";
const HAIR = "C7D0D9";

const PAGE = { width: mm(210), height: mm(297) };
const MARGIN = { top: mm(22), right: mm(25), bottom: mm(20), left: mm(25) };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right;

// ====== EDIT YOUR DATA HERE ======
const data = {
  org: "Example Ltd",
  to: "Digital transformation team",
  from: "John Sample, Managing Director",
  cc: "Extended management board",
  date: new Date(2026, 5, 1),
  subject: "Project kick-off — next steps",
  body: [
    "Following yesterday's meeting, this note records the key outcomes and the next steps we agreed.",
    "The project starts on 15 June 2026. Jane Schmidt will take over project management. A weekly check-in takes place every Monday at 9:00.",
  ],
  actions: [
    "By 08 June: survey of existing systems (owner: IT)",
    "By 12 June: draft project plan (owner: PMO)",
    "By 15 June: sign-off by management",
  ],
  closing: "Please get in touch if you have any questions.",
};
// ========================================================

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const tableNoBorders = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER };

const numbering = { config: [{ reference: "memo-bullets", levels: [
  { level: 0, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT,
    style: { run: { color: ACCENT }, paragraph: { indent: { left: mm(7), hanging: mm(5) } } } },
]}]};

// meta row: bold label (fixed width) + value
const labelW = mm(28);
const metaRow = (label, value) => new TableRow({ children: [
  new TableCell({ width: { size: labelW, type: WidthType.DXA }, borders: tableNoBorders, verticalAlign: VerticalAlign.TOP,
    margins: { top: 30, bottom: 30, left: 0, right: mm(3) },
    children: [new Paragraph({ children: [new TextRun({ text: label, size: S(10), bold: true, color: MUTED })] })] }),
  new TableCell({ width: { size: CONTENT_W - labelW, type: WidthType.DXA }, borders: tableNoBorders, verticalAlign: VerticalAlign.TOP,
    margins: { top: 30, bottom: 30, left: 0, right: 0 },
    children: [new Paragraph({ children: [new TextRun({ text: value, size: S(10.5), color: INK })] })] }),
]});

const metaRows = [
  metaRow("To:", data.to),
  metaRow("From:", data.from),
];
if (data.cc) metaRows.push(metaRow("CC:", data.cc));
metaRows.push(metaRow("Date:", dateLong(data.date)));
metaRows.push(metaRow("Subject:", data.subject));

const children = [
  // Title bar
  new Paragraph({ spacing: { after: 40 }, children: [
    new TextRun({ text: "MEMO", size: S(22), bold: true, color: ACCENT, characterSpacing: 40 }),
    new TextRun({ text: "    " + data.org, size: S(10), color: MUTED }),
  ]}),
  new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 1 } }, spacing: { after: 200, line: 1 }, children: [new TextRun({ text: "", size: S(1) })] }),
  // Meta block
  new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [labelW, CONTENT_W - labelW], borders: tableNoBorders, rows: metaRows }),
  new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: HAIR, space: 6 } }, spacing: { before: 120, after: 240, line: 1 }, children: [new TextRun({ text: "", size: S(1) })] }),
  // Body
  ...data.body.map(p => new Paragraph({ spacing: { after: 160, line: 288 }, children: [new TextRun({ text: p, size: S(11) })] })),
];

if (data.actions && data.actions.length) {
  children.push(new Paragraph({ spacing: { before: 120, after: 80 }, children: [new TextRun({ text: "Next steps", size: S(12), bold: true, color: ACCENT })] }));
  data.actions.forEach(a => children.push(new Paragraph({ numbering: { reference: "memo-bullets", level: 0 }, spacing: { after: 60, line: 276 }, children: [new TextRun({ text: a, size: S(11) })] })));
}
if (data.closing) children.push(new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: data.closing, size: S(11) })] }));

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: S(11), color: INK } } } },
  numbering,
  sections: [{
    properties: { page: { size: PAGE, margin: MARGIN } },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: HAIR, space: 4 } },
      children: [
        new TextRun({ text: data.org + "  ·  Internal memo  ·  Page ", size: S(8), color: MUTED }),
        new TextRun({ children: [PageNumber.CURRENT], size: S(8), color: MUTED }),
      ],
    })] }) },
    children,
  }],
});

const out = process.argv[2] || "memo.docx";
Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log("written:", out); });
