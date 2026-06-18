// Builds an .xlsx workbook listing the patients who received each of the three
// tracked screening services within a date range.
//
// Layout: a leading "สรุป" sheet with the per-service counts, then one sheet per
// service (ยาเสริมธาตุเหล็ก | HPV | Fit test). Each service sheet has the columns
// ลำดับ | วันที่ | เวลา | ชื่อ-สกุล | PID. A patient who received two services on
// the same visit appears once on each relevant sheet.

const ExcelJS = require('exceljs');
const db = require('./db');

const COLUMNS = [
  { header: 'ลำดับ', key: 'no', width: 8 },
  { header: 'วันที่', key: 'date', width: 14 },
  { header: 'เวลา', key: 'time', width: 10 },
  { header: 'ชื่อ-สกุล', key: 'name', width: 38 },
  { header: 'PID', key: 'pid', width: 12 },
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

// rows: array from db.screeningPatients(). from/to: the requested date range,
// shown on the summary sheet. Returns a populated ExcelJS.Workbook.
function buildWorkbook(rows, from, to) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'JHCIS Dashboard';
  wb.created = new Date(0); // deterministic; real timestamp not needed in file

  // Group rows by diagcode, in the canonical service order.
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.diagcode)) groups.set(r.diagcode, []);
    groups.get(r.diagcode).push(r);
  }

  // Summary sheet. Columns carry keys/widths only; the title (row 1) and header
  // (row 2) are written by hand so the table can sit below a merged title.
  const summary = wb.addWorksheet('สรุป');
  summary.columns = [
    { key: 'label', width: 28 },
    { key: 'code', width: 14 },
    { key: 'count', width: 18 },
  ];
  summary.mergeCells('A1:C1');
  const title = summary.getCell('A1');
  title.value = `รายชื่อผู้รับบริการคัดกรอง • ${from} ถึง ${to}`;
  title.font = { bold: true, size: 13 };
  summary.getRow(2).values = ['บริการ', 'รหัส ICD-10', 'จำนวน (คน-ครั้ง)'];
  styleHeader(summary.getRow(2));

  let total = 0;
  for (const svc of db.SCREENING_CODES) {
    const g = groups.get(svc.code) || [];
    total += g.length;
    summary.addRow({ label: svc.label, code: svc.code, count: g.length });
  }
  const totalRow = summary.addRow({ label: 'รวมทั้งหมด', code: '', count: total });
  totalRow.font = { bold: true };

  // One sheet per service (always present, even if empty).
  const usedNames = new Set(['สรุป']);
  for (const svc of db.SCREENING_CODES) {
    const g = groups.get(svc.code) || [];
    const ws = wb.addWorksheet(safeSheetName(svc.label, usedNames));
    ws.columns = COLUMNS.map(({ header, key, width }) => ({ header, key, width }));
    styleHeader(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    g.forEach((r, i) => {
      ws.addRow({
        no: i + 1,
        date: r.date,
        time: r.time || '',
        name: r.name,
        pid: r.pid,
      });
    });
    ws.autoFilter = { from: 'A1', to: 'E1' };
  }

  return wb;
}

module.exports = { buildWorkbook, COLUMNS };
