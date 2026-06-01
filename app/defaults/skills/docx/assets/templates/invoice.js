// Invoice / quote — A4, line-item table + VAT breakdown + payment details. English, European conventions.
// Standalone docx-js generator. Edit the `data` block, then: node invoice.js [out.docx]
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, TabStopType, WidthType, BorderStyle, ShadingType, VerticalAlign,
  Footer,
} = require("docx");

// ---------- unit + locale helpers ----------
const mm = v => Math.round(v * 1440 / 25.4);
const S  = pt => Math.round(pt * 2);
const MONTHS = ["January","February","March","April","May","June","July","August",
                "September","October","November","December"];
const dateLong  = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;            // "1 June 2026"
const dateShort = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; // ISO "2026-06-01"
const eur = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" });   // €1,234.56
const qty = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// ---------- theme ----------
const FONT = "Arial";
const ACCENT = "1F3A5F";
const INK = "1A1A1A";
const MUTED = "6B7682";
const HAIR = "C7D0D9";
const PANEL = "EEF2F6";

const PAGE = { width: mm(210), height: mm(297) };
const MARGIN = { top: mm(20), right: mm(20), bottom: mm(18), left: mm(25) };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right;

// ====== EDIT YOUR DATA HERE ======
const data = {
  docType: "Invoice",                  // "Invoice" or "Quote"
  sender: { name: "Example Ltd", lines: ["123 Example Street", "12345 Sample City"] },
  returnLine: "Example Ltd · 123 Example Street · 12345 Sample City",
  recipient: ["Acme Corporation", "Dr Jane Doe", "1 Example Avenue", "54321 Sample Town"],
  meta: {
    "Invoice number": "2026-0142",
    "Invoice date": dateShort(new Date(2026, 5, 1)),
    "Service period": "May 2026",
    "Customer number": "C-1007",
  },
  place: "Sample City",
  date: new Date(2026, 5, 1),
  intro: "For the services rendered, we are pleased to invoice you as follows:",
  items: [
    { desc: "Consulting – digital strategy", qty: 12, unit: "hrs", price: 145.0 },
    { desc: "Workshop facilitation (day rate)", qty: 2, unit: "days", price: 1200.0 },
    { desc: "Documentation and final report", qty: 1, unit: "flat", price: 850.0 },
  ],
  taxRate: 0.19,                       // 19% VAT; set to 0.07 for the reduced rate
  smallBusiness: false,               // true => no VAT shown (small-business exemption)
  paymentDays: 14,
  bank: { holder: "Example Ltd", iban: "DE00 1234 5678 9012 3456 00", bic: "EXAMDEFFXXX", bank: "Example Bank" },
  legal: ["Example Ltd · Commercial register HRB 12345", "Managing director: John Sample · VAT ID DE123456789"],
};
// ========================================================

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const tableNoBorders = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER };
const cellP = (text, { align = AlignmentType.LEFT, s = 10.5, b = false, c = INK } = {}) =>
  new Paragraph({ alignment: align, spacing: { after: 0, line: 252 }, children: [new TextRun({ text, size: S(s), bold: b, color: c })] });

// ----- line items -----
const net = data.items.reduce((sum, it) => sum + it.qty * it.price, 0);
const tax = data.smallBusiness ? 0 : net * data.taxRate;
const gross = net + tax;

// column widths: No | Description | Qty | Unit price | Amount
const W = { pos: mm(12), desc: 0, qty: mm(24), price: mm(28), total: mm(28) };
W.desc = CONTENT_W - W.pos - W.qty - W.price - W.total;
const colW = [W.pos, W.desc, W.qty, W.price, W.total];

const itemCell = (text, align, opts = {}) => new TableCell({
  width: { size: opts.w, type: WidthType.DXA },
  shading: opts.head ? { fill: ACCENT, type: ShadingType.CLEAR, color: "auto" } : (opts.zebra ? { fill: PANEL, type: ShadingType.CLEAR, color: "auto" } : undefined),
  margins: { top: 70, bottom: 70, left: 110, right: 110 },
  borders: { bottom: { style: BorderStyle.SINGLE, size: 2, color: HAIR } },
  verticalAlign: VerticalAlign.CENTER,
  children: [cellP(text, { align, s: 10.5, b: opts.head, c: opts.head ? "FFFFFF" : INK })],
});

const itemRow = (cells, opts = {}) => new TableRow({ tableHeader: !!opts.head, children: [
  itemCell(cells[0], AlignmentType.LEFT,  { w: colW[0], ...opts }),
  itemCell(cells[1], AlignmentType.LEFT,  { w: colW[1], ...opts }),
  itemCell(cells[2], AlignmentType.RIGHT, { w: colW[2], ...opts }),
  itemCell(cells[3], AlignmentType.RIGHT, { w: colW[3], ...opts }),
  itemCell(cells[4], AlignmentType.RIGHT, { w: colW[4], ...opts }),
]});

const itemsTable = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: colW,
  rows: [
    itemRow(["No.", "Description", "Qty", "Unit price", "Amount"], { head: true }),
    ...data.items.map((it, i) => itemRow(
      [String(i + 1), it.desc, `${qty.format(it.qty)} ${it.unit}`, eur.format(it.price), eur.format(it.qty * it.price)],
      { zebra: i % 2 === 1 })),
  ],
});

// ----- totals block (right-aligned, ~half width) -----
const totW = Math.round(CONTENT_W * 0.5);
const totRow = (label, value, opts = {}) => new TableRow({ children: [
  new TableCell({ width: { size: Math.round(totW * 0.6), type: WidthType.DXA }, borders: { top: opts.rule ? { style: BorderStyle.SINGLE, size: 6, color: ACCENT } : NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
    shading: opts.total ? { fill: PANEL, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 50, bottom: 50, left: 100, right: 100 },
    children: [cellP(label, { s: opts.total ? 11.5 : 10.5, b: opts.total, c: opts.total ? ACCENT : INK })] }),
  new TableCell({ width: { size: Math.round(totW * 0.4), type: WidthType.DXA }, borders: { top: opts.rule ? { style: BorderStyle.SINGLE, size: 6, color: ACCENT } : NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
    shading: opts.total ? { fill: PANEL, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 50, bottom: 50, left: 100, right: 100 },
    children: [cellP(value, { align: AlignmentType.RIGHT, s: opts.total ? 11.5 : 10.5, b: opts.total, c: opts.total ? ACCENT : INK })] }),
]});

const totalsRows = [totRow("Subtotal (net)", eur.format(net))];
if (!data.smallBusiness) totalsRows.push(totRow(`plus ${(data.taxRate * 100).toLocaleString("en-GB")}% VAT`, eur.format(tax)));
totalsRows.push(totRow(data.smallBusiness ? "Total" : "Total (gross)", eur.format(gross), { total: true, rule: true }));

const totalsTable = new Table({
  alignment: AlignmentType.RIGHT,
  width: { size: totW, type: WidthType.DXA }, columnWidths: [Math.round(totW * 0.6), Math.round(totW * 0.4)],
  rows: totalsRows,
});

// ----- sender/recipient header (two columns) -----
const headerBlock = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [mm(95), CONTENT_W - mm(95)], borders: tableNoBorders,
  rows: [new TableRow({ children: [
    new TableCell({ width: { size: mm(95), type: WidthType.DXA }, borders: tableNoBorders, verticalAlign: VerticalAlign.TOP, margins: { right: mm(4) }, children: [
      new Paragraph({ spacing: { after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: MUTED, space: 1 } }, children: [new TextRun({ text: data.returnLine, size: S(7), color: MUTED })] }),
      ...data.recipient.map((l, i) => new Paragraph({ spacing: { after: 0, line: 276 }, children: [new TextRun({ text: l, size: S(11), bold: i === 0, color: INK })] })),
    ]}),
    new TableCell({ width: { size: CONTENT_W - mm(95), type: WidthType.DXA }, borders: tableNoBorders, verticalAlign: VerticalAlign.TOP, children: [
      new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 120 }, children: [new TextRun({ text: data.sender.name, size: S(14), bold: true, color: ACCENT })] }),
      ...data.sender.lines.map(l => new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 240 }, children: [new TextRun({ text: l, size: S(9), color: MUTED })] })),
    ]}),
  ]})],
});

// ----- meta strip -----
const metaStrip = new Paragraph({
  spacing: { before: 360, after: 120 },
  tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
  children: [
    new TextRun({ text: `${data.place}, ${dateLong(data.date)}`, size: S(10), color: MUTED }),
  ],
});
const metaTable = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: Object.keys(data.meta).map(() => Math.round(CONTENT_W / Object.keys(data.meta).length)), borders: tableNoBorders,
  rows: [
    new TableRow({ children: Object.keys(data.meta).map(k => new TableCell({ borders: tableNoBorders, margins: { top: 20, bottom: 10 }, children: [cellP(k, { s: 8, c: MUTED })] })) }),
    new TableRow({ children: Object.values(data.meta).map(v => new TableCell({ borders: tableNoBorders, margins: { top: 0, bottom: 20 }, children: [cellP(v, { s: 10.5, b: true })] })) }),
  ],
});

const children = [
  headerBlock,
  metaStrip,
  new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${data.docType} No. ${data.meta["Invoice number"]}`, size: S(18), bold: true, color: ACCENT })] }),
  metaTable,
  new Paragraph({ spacing: { before: 160, after: 240 }, children: [new TextRun({ text: "Dear Sir or Madam,", size: S(11) })] }),
  new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: data.intro, size: S(11) })] }),
  itemsTable,
  new Paragraph({ spacing: { after: 120 }, children: [] }),
  totalsTable,
];

if (data.smallBusiness) {
  children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: "Exempt from VAT under the small-business rule (§ 19 UStG).", size: S(10), color: MUTED })] }));
}

children.push(
  new Paragraph({ spacing: { before: 320, after: 60 }, children: [new TextRun({
    text: data.smallBusiness
      ? `Please transfer the amount within ${data.paymentDays} days to the account below.`
      : `Please transfer the total within ${data.paymentDays} days net, quoting the invoice number, to the account below:`,
    size: S(11) })] }),
  new Paragraph({ spacing: { before: 80, after: 0, line: 252 }, children: [
    new TextRun({ text: "Account holder: ", size: S(10), color: MUTED }), new TextRun({ text: data.bank.holder, size: S(10) }),
  ]}),
  new Paragraph({ spacing: { after: 0, line: 252 }, children: [
    new TextRun({ text: "IBAN: ", size: S(10), color: MUTED }), new TextRun({ text: data.bank.iban, size: S(10) }),
    new TextRun({ text: "   BIC: ", size: S(10), color: MUTED }), new TextRun({ text: data.bank.bic, size: S(10) }),
  ]}),
  new Paragraph({ spacing: { after: 0, line: 252 }, children: [
    new TextRun({ text: "Reference: ", size: S(10), color: MUTED }), new TextRun({ text: data.meta["Invoice number"], size: S(10) }),
  ]}),
  new Paragraph({ spacing: { before: 360 }, children: [new TextRun({ text: "Kind regards", size: S(11) })] }),
  new Paragraph({ spacing: { before: 480 }, children: [new TextRun({ text: data.sender.name, size: S(11), bold: true })] }),
);

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: S(11), color: INK } } } },
  sections: [{
    properties: { page: { size: PAGE, margin: MARGIN } },
    footers: { default: new Footer({ children: [
      new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 4, color: HAIR, space: 4 } }, spacing: { after: 0, line: 1 }, children: [new TextRun({ text: "", size: S(1) })] }),
      ...data.legal.map(l => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0, line: 200 }, children: [new TextRun({ text: l, size: S(7.5), color: MUTED })] })),
    ] }) },
    children,
  }],
});

const out = process.argv[2] || "invoice.docx";
Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log("written:", out); });
