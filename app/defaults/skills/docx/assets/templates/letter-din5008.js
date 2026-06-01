// Business letter (A4, DIN 5008 layout) — English, European conventions.
// Standalone docx-js generator. Edit the `data` block, then: node letter-din5008.js [out.docx]
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, TabStopType, WidthType, BorderStyle, VerticalAlign,
  Footer, PageNumber, FrameAnchorType,
} = require("docx");

// ---------- unit + locale helpers ----------
const mm = v => Math.round(v * 1440 / 25.4);   // millimeters -> DXA (twips)
const S  = pt => Math.round(pt * 2);           // points -> half-points (font size)
const MONTHS = ["January","February","March","April","May","June","July","August",
                "September","October","November","December"];
const dateLong = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; // produces e.g. "1 June 2026"

// ---------- theme ----------
const FONT   = "Arial";
const ACCENT = "1F3A5F"; // restrained dark slate-blue — change to your brand colour
const INK    = "1A1A1A"; // near-black body text
const MUTED  = "6B7682"; // small print / labels
const HAIR   = "B8C2CC"; // hairlines

// A4 + DIN 5008 margins: left 25mm, right 20mm
const PAGE = { width: mm(210), height: mm(297) };
const MARGIN = { top: mm(20), right: mm(20), bottom: mm(16), left: mm(25) };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right; // 165mm

// ====== EDIT YOUR DATA HERE ======
const data = {
  foldMarks: true,                                 // fold + hole-punch marks for window envelopes (left edge). Best in Word/LibreOffice.
  senderLetterhead: "Example Ltd",                 // big letterhead line (or your logo)
  returnLine: "Example Ltd · 123 Example Street · 12345 Sample City", // return-address line (small)
  recipient: [
    "Acme Corporation",
    "Dr Jane Doe",
    "1 Example Avenue",
    "54321 Sample Town",
  ],
  info: {                                          // info block (right column)
    "Your ref": "—",
    "Our ref": "EX-2026-014",
    "Phone": "+49 30 1234567",
    "Email": "info@example.com",
  },
  place: "Sample City",
  date: new Date(2026, 5, 1),                       // month is 0-based: 5 = June
  subject: "Proposal for consulting services",
  salutation: "Dear Dr Doe,",
  body: [
    "Thank you for your enquiry of 20 May 2026. We are pleased to set out our proposal for supporting your digitalisation project below.",
    "Our proposal comprises an as-is analysis, the development of a roadmap, and support throughout implementation over a period of six months. A detailed scope of services is enclosed.",
    "If you have any questions, we are glad to help at any time. We look forward to working with you.",
  ],
  closing: "Kind regards",
  signName: "John Sample",
  signRole: "Managing Director",
  enclosures: ["Scope of services", "Reference list"],
  footerCols: [
    ["Example Ltd", "123 Example Street", "12345 Sample City"],
    ["Phone +49 30 1234567", "info@example.com", "www.example.com"],
    ["Commercial register HRB 12345", "VAT ID DE123456789", "DE00 1234 5678 9012 3456 00"],
  ],
};
// ========================================================

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const tableNoBorders = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
};

// Fold marks + hole-punch mark as page-anchored frames
const foldMark = (yMM, len = 4) => new Paragraph({
  frame: {
    type: "absolute",
    anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
    position: { x: mm(3), y: mm(yMM) }, width: mm(len), height: mm(1),
  },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: HAIR, space: 0 } },
  spacing: { after: 0, line: 1 },
  children: [new TextRun({ text: " ", size: S(1) })],
});

// Address + info block (two borderless columns at the DIN address-field height)
const addressBlock = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA },
  columnWidths: [mm(95), CONTENT_W - mm(95)],
  borders: tableNoBorders,
  rows: [new TableRow({ children: [
    new TableCell({
      width: { size: mm(95), type: WidthType.DXA }, borders: tableNoBorders, verticalAlign: VerticalAlign.TOP,
      margins: { top: 0, bottom: 0, left: 0, right: mm(4) },
      children: [
        new Paragraph({
          spacing: { after: 120 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: MUTED, space: 1 } },
          children: [new TextRun({ text: data.returnLine, size: S(7), color: MUTED })],
        }),
        ...data.recipient.map((line, i) => new Paragraph({
          spacing: { after: 0, line: 280 },
          children: [new TextRun({ text: line, size: S(11), color: INK, bold: i === 0 })],
        })),
      ],
    }),
    new TableCell({
      width: { size: CONTENT_W - mm(95), type: WidthType.DXA }, borders: tableNoBorders, verticalAlign: VerticalAlign.BOTTOM,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      children: Object.entries(data.info).map(([k, v]) => new Paragraph({
        spacing: { after: 20, line: 240 },
        children: [
          new TextRun({ text: k, size: S(8), color: MUTED }),
          new TextRun({ text: "\t" + v, size: S(9), color: INK }),
        ],
        tabStops: [{ type: TabStopType.LEFT, position: mm(28) }],
      })),
    }),
  ]})],
});

// Footer: hairline + three columns of small print + page number
const footer = new Footer({ children: [
  new Paragraph({
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: ACCENT, space: 4 } },
    spacing: { before: 0, after: 0, line: 1 },
    children: [new TextRun({ text: "", size: S(1) })],
  }),
  ...[0, 1, 2].map(row => new Paragraph({
    spacing: { after: 0, line: 220 },
    tabStops: [
      { type: TabStopType.CENTER, position: Math.round(CONTENT_W / 2) },
      { type: TabStopType.RIGHT, position: CONTENT_W },
    ],
    children: [
      new TextRun({ text: data.footerCols[0][row] || "", size: S(7.5), color: MUTED }),
      new TextRun({ text: "\t" + (data.footerCols[1][row] || ""), size: S(7.5), color: MUTED }),
      new TextRun({ text: "\t" + (data.footerCols[2][row] || ""), size: S(7.5), color: MUTED }),
    ],
  })),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 80, line: 220 },
    children: [
      new TextRun({ text: "Page ", size: S(7.5), color: MUTED }),
      new TextRun({ children: [PageNumber.CURRENT], size: S(7.5), color: MUTED }),
      new TextRun({ text: " of ", size: S(7.5), color: MUTED }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], size: S(7.5), color: MUTED }),
    ],
  }),
]});

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: S(11), color: INK } } } },
  sections: [{
    properties: { page: { size: PAGE, margin: MARGIN } },
    footers: { default: footer },
    children: [
      // Fold marks + hole-punch mark — page-anchored frames, do not affect flow.
      // Render correctly in Word/LibreOffice; toggle off via data.foldMarks if a viewer misplaces them.
      ...(data.foldMarks ? [foldMark(105), foldMark(210), foldMark(148.5, 6)] : []),
      // Letterhead
      new Paragraph({
        alignment: AlignmentType.RIGHT, spacing: { after: 60 },
        children: [new TextRun({ text: data.senderLetterhead, size: S(18), bold: true, color: ACCENT })],
      }),
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 2 } },
        spacing: { after: 240, line: 1 }, children: [new TextRun({ text: "", size: S(1) })],
      }),
      // Address + info at DIN address-field height
      addressBlock,
      // Date line (place + written-out date)
      new Paragraph({
        alignment: AlignmentType.RIGHT, spacing: { before: 360, after: 360 },
        children: [new TextRun({ text: `${data.place}, ${dateLong(data.date)}`, size: S(11) })],
      }),
      // Subject (bold)
      new Paragraph({
        spacing: { after: 280 },
        children: [new TextRun({ text: data.subject, size: S(11), bold: true })],
      }),
      // Salutation
      new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: data.salutation, size: S(11) })] }),
      // Body
      ...data.body.map(p => new Paragraph({
        alignment: AlignmentType.LEFT, spacing: { after: 200, line: 276 },
        children: [new TextRun({ text: p, size: S(11) })],
      })),
      // Closing
      new Paragraph({ spacing: { before: 120, after: 720 }, children: [new TextRun({ text: data.closing, size: S(11) })] }),
      new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: data.signName, size: S(11), bold: true })] }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: data.signRole, size: S(10), color: MUTED })] }),
      // Enclosures
      ...(data.enclosures && data.enclosures.length ? [
        new Paragraph({ spacing: { before: 240, after: 40 }, children: [new TextRun({ text: "Enclosures", size: S(10), bold: true })] }),
        ...data.enclosures.map(a => new Paragraph({ spacing: { after: 0, line: 240 }, children: [new TextRun({ text: a, size: S(10), color: INK })] })),
      ] : []),
    ],
  }],
});

const out = process.argv[2] || "letter-din5008.docx";
Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log("written:", out); });
