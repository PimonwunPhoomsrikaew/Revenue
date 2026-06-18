// Builds an .xlsx workbook from a drug master list.
//
// Layout: one worksheet per category, each with exactly the four requested
// columns — รหัสยา-เวชภัณฑ์ | ชื่อยา | ราคาทุน | ราคาขาย. A leading "สรุป"
// sheet lists the categories and their row counts. Shared by the CLI export
// script and the web download endpoint so both produce identical files.

const ExcelJS = require('exceljs');
const drugs = require('./drugs');

const COLUMNS = [
  { header: 'รหัสยา-เวชภัณฑ์', key: 'code', width: 28 },
  { header: 'ชื่อยา', key: 'name', width: 45 },
  { header: 'ราคาทุน', key: 'cost', width: 12, numFmt: '#,##0.00' },
  { header: 'ราคาขาย', key: 'sell', width: 12, numFmt: '#,##0.00' },
];

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle' };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } };
  });
}

// Excel worksheet names may not contain : \ / ? * [ ] and max 31 chars.
function safeSheetName(label, used) {
  let name = label.replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
  let n = name;
  let i = 2;
  while (used.has(n)) n = `${name.slice(0, 28)} ${i++}`;
  used.add(n);
  return n;
}

// rows: array from drugs.list(). Returns a populated ExcelJS.Workbook.
function buildWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'JHCIS Dashboard';
  wb.created = new Date(0); // deterministic; real timestamp not needed in file

  // Group rows by category, preserving the canonical category order.
  const order = drugs.CATEGORIES.map((c) => c.key);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.categoryKey)) groups.set(r.categoryKey, []);
    groups.get(r.categoryKey).push(r);
  }
  const orderedKeys = [...groups.keys()].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b)
  );

  // Summary sheet.
  const summary = wb.addWorksheet('สรุป');
  summary.columns = [
    { header: 'หมวด', key: 'label', width: 38 },
    { header: 'จำนวนรายการ', key: 'count', width: 16 },
  ];
  styleHeader(summary.getRow(1));
  let total = 0;
  for (const key of orderedKeys) {
    const g = groups.get(key);
    total += g.length;
    summary.addRow({ label: g[0].categoryLabel, count: g.length });
  }
  const totalRow = summary.addRow({ label: 'รวมทั้งหมด', count: total });
  totalRow.font = { bold: true };

  // One sheet per category.
  const usedNames = new Set(['สรุป']);
  for (const key of orderedKeys) {
    const g = groups.get(key);
    const ws = wb.addWorksheet(safeSheetName(g[0].categoryLabel, usedNames));
    ws.columns = COLUMNS.map(({ header, key: k, width }) => ({ header, key: k, width }));
    styleHeader(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of g) {
      ws.addRow({ code: r.code, name: r.name, cost: r.cost, sell: r.sell });
    }
    // Number format on the price columns.
    ws.getColumn('cost').numFmt = '#,##0.00';
    ws.getColumn('sell').numFmt = '#,##0.00';
    ws.autoFilter = { from: 'A1', to: `D1` };
  }

  return wb;
}

module.exports = { buildWorkbook, COLUMNS };
