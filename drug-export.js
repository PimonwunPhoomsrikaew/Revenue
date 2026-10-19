// Builds an .xlsx workbook from a drug master list.
//
// Layout: one worksheet per category, each with exactly the four requested
// columns — รหัสยา-เวชภัณฑ์ | ชื่อยา | ราคาทุน | ราคาขาย. A leading "สรุป"
// sheet lists the categories and their row counts. Shared by the CLI export
// script and the web download endpoint so both produce identical files.
//
// When `transactions` is supplied (dispensing lines for a date range, from
// drugs.transactionsForDate), a second sheet is appended right after each
// category sheet showing that range's activity for the category: a per-drug
// summary (qty/amount dispensed) followed by the per-visit detail.

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

function styleSubHeading(cell) {
  cell.font = { bold: true, size: 11 };
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

// Appends a transaction sheet for one category right after its master-list
// sheet, covering a date range (single day when dateLabel names one date).
// txRows: this category's rows from transactionsForDate.
function addTransactionSheet(wb, categoryLabel, dateLabel, txRows, usedNames) {
  const suffix = ' (ตามช่วงวันที่)';
  const base = categoryLabel.replace(/[:\\/?*[\]]/g, '-').slice(0, 31 - suffix.length);
  const ws = wb.addWorksheet(safeSheetName(`${base}${suffix}`, usedNames));

  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 38;
  ws.getColumn(3).width = 14;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 16;
  ws.getColumn(6).width = 28;
  ws.getColumn(7).width = 18;
  ws.getColumn(8).width = 38;
  ws.getColumn(9).width = 10;

  const title = ws.getCell('A1');
  title.value = `ทรานแซคชัน • ${categoryLabel} • วันที่ ${dateLabel}`;
  title.font = { bold: true, size: 13 };
  ws.mergeCells('A1:D1');

  // Per-drug summary for the range: how many patients received it and how much.
  ws.getCell('A3').value = 'สรุปยอดรวมช่วงวันที่ (แยกตามรายการยา)';
  styleSubHeading(ws.getCell('A3'));
  ws.getRow(4).values = ['รหัสยา-เวชภัณฑ์', 'ชื่อยา', 'จำนวนคนไข้', 'จำนวนที่จ่าย'];
  styleHeader(ws.getRow(4));

  const summary = drugs.aggregateByDrug(txRows);
  let row = 5;
  for (const g of summary) {
    ws.getRow(row).values = [g.code, g.name, g.patientCount, g.qty];
    ws.getCell(row, 4).numFmt = '#,##0.##';
    row++;
  }
  if (summary.length === 0) {
    ws.getCell(row, 1).value = 'ไม่มีรายการจ่ายในช่วงวันที่นี้';
    row++;
  }

  // Per-visit detail.
  row += 1;
  ws.getCell(row, 1).value = 'รายการละเอียด (แต่ละ Visit)';
  styleSubHeading(ws.getCell(row, 1));
  row++;
  ws.getRow(row).values = [
    'ลำดับ', 'วันที่', 'เวลา', 'เลข Visit', 'PID', 'ชื่อ-สกุล',
    'รหัสยา', 'ชื่อยา', 'จำนวน',
  ];
  styleHeader(ws.getRow(row));
  txRows.forEach((r, i) => {
    row++;
    ws.getRow(row).values = [
      i + 1, r.date, r.time, r.visitno, r.pid, r.patientName,
      r.code, r.name, r.qty,
    ];
    ws.getCell(row, 9).numFmt = '#,##0.##';
  });
}

// Appends the "ยอดยาคงเหลือ" sheet: current remaining stock (live balance,
// not date-filtered — see drugs.remaining) for every medicine item, labelled
// with the single date the caller picked for the report.
// rows: array from drugs.remaining().
function addRemainingStockSheet(wb, dateLabel, rows, usedNames) {
  const ws = wb.addWorksheet(safeSheetName('ยอดยาคงเหลือ', usedNames));
  ws.columns = [
    { header: 'รหัสยา', key: 'code', width: 20 },
    { header: 'ชื่อยา', key: 'name', width: 45 },
    { header: 'หมวด', key: 'categoryLabel', width: 24 },
    { header: 'หน่วย', key: 'unit', width: 12 },
    { header: 'ยอดคงเหลือ', key: 'remain', width: 16 },
  ];

  ws.spliceRows(1, 0, []);
  const title = ws.getCell('A1');
  title.value = `ยอดยาคงเหลือ ณ วันที่ ${dateLabel}`;
  title.font = { bold: true, size: 13 };
  ws.mergeCells('A1:E1');

  styleHeader(ws.getRow(2));
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  for (const r of rows) {
    ws.addRow({ code: r.code, name: r.name, categoryLabel: r.categoryLabel, unit: r.unit, remain: r.remain });
  }
  ws.getColumn('remain').numFmt = '#,##0';
  if (rows.length) ws.autoFilter = { from: 'A2', to: 'E2' };
}

// rows: array from drugs.list(). opts.dateLabel/opts.transactions (optional):
// a date range's dispensing lines from drugs.transactionsForDate plus a
// display label for it (e.g. "2026-08-21" or "2026-08-01 ถึง 2026-08-05"),
// to append a per-category transaction sheet. opts.remaining (optional):
// { dateLabel, rows } — rows from drugs.remaining() plus the single date the
// caller picked, to append the current-stock sheet described above. Returns
// a populated ExcelJS.Workbook.
function buildWorkbook(rows, opts) {
  const { dateLabel, transactions, remaining } = opts || {};
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Revenue';
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

  // This day's transactions, grouped by category (for the per-category sheets).
  const txByCategory = new Map();
  if (transactions) {
    for (const t of transactions) {
      if (!txByCategory.has(t.categoryKey)) txByCategory.set(t.categoryKey, []);
      txByCategory.get(t.categoryKey).push(t);
    }
  }

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

  // One sheet per category, followed by that category's transaction sheet
  // when a day's transactions were supplied.
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

    if (transactions) {
      addTransactionSheet(wb, g[0].categoryLabel, dateLabel, txByCategory.get(key) || [], usedNames);
    }
  }

  if (remaining) {
    addRemainingStockSheet(wb, remaining.dateLabel, remaining.rows, usedNames);
  }

  return wb;
}

// Builds the dedicated "ยอดจ่ายรายวัน" workbook: a per-drug summary plus a
// per-visit detail, for a caller-chosen set of drug codes over a date range.
// transactions: rows from drugs.transactionsForDate, already restricted to
// the selected codes. dateLabel: display string for the range (see
// buildWorkbook). One sheet only — unlike buildWorkbook this has no master
// price-list sheets, since it always operates on an explicit item selection.
function buildDispensingWorkbook(transactions, dateLabel) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Revenue';
  wb.created = new Date(0);

  const ws = wb.addWorksheet('ยอดจ่ายรายวัน');
  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 38;
  ws.getColumn(3).width = 24;
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 16;
  ws.getColumn(6).width = 28;
  ws.getColumn(7).width = 18;
  ws.getColumn(8).width = 38;
  ws.getColumn(9).width = 24;
  ws.getColumn(10).width = 10;

  const title = ws.getCell('A1');
  title.value = `ยอดจ่ายรายวัน • วันที่ ${dateLabel}`;
  title.font = { bold: true, size: 13 };
  ws.mergeCells('A1:E1');

  ws.getCell('A3').value = 'สรุปยอดจ่าย (แยกตามรายการยา)';
  styleSubHeading(ws.getCell('A3'));
  ws.getRow(4).values = ['รหัสยา-เวชภัณฑ์', 'ชื่อยา', 'หมวด', 'จำนวนคนไข้', 'จำนวนที่จ่าย'];
  styleHeader(ws.getRow(4));

  const summary = drugs
    .aggregateByDrug(transactions)
    .sort((a, b) => a.categoryKey.localeCompare(b.categoryKey) || a.name.localeCompare(b.name));
  let row = 5;
  for (const g of summary) {
    ws.getRow(row).values = [g.code, g.name, g.categoryLabel, g.patientCount, g.qty];
    ws.getCell(row, 5).numFmt = '#,##0.##';
    row++;
  }
  if (summary.length === 0) {
    ws.getCell(row, 1).value = 'ไม่มีรายการจ่ายในช่วงวันที่นี้';
    row++;
  }

  row += 1;
  ws.getCell(row, 1).value = 'รายการละเอียด (แต่ละ Visit)';
  styleSubHeading(ws.getCell(row, 1));
  row++;
  ws.getRow(row).values = [
    'ลำดับ', 'วันที่', 'เวลา', 'เลข Visit', 'PID', 'ชื่อ-สกุล',
    'รหัสยา', 'ชื่อยา', 'หมวด', 'จำนวน',
  ];
  styleHeader(ws.getRow(row));
  transactions.forEach((r, i) => {
    row++;
    ws.getRow(row).values = [
      i + 1, r.date, r.time, r.visitno, r.pid, r.patientName,
      r.code, r.name, r.categoryLabel, r.qty,
    ];
    ws.getCell(row, 10).numFmt = '#,##0.##';
  });

  return wb;
}

module.exports = { buildWorkbook, buildDispensingWorkbook, COLUMNS };
