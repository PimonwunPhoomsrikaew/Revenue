// Drug / medical-supply master module.
//
// Source of truth is the JHCIS `cdrug` table, which mixes real drugs,
// medical supplies, vaccines, herbal medicine and service/procedure items
// in one table. They are distinguished by the `drugtype` column. This
// module maps each drugtype to a human (Thai) category so callers can
// browse and export the master list category-by-category — the foundation
// for an inventory/pricing module in a future hospital ERP.

const db = require('./db');

// drugtype code -> { key, label }. Order here is the display order.
// `key` is what the API/UI uses; `code` is the raw cdrug.drugtype value.
// The special key '_none' covers rows whose drugtype is NULL/empty.
const CATEGORIES = [
  { code: '01', key: '01', label: 'ยาแผนปัจจุบัน' },
  { code: '02', key: '02', label: 'ยา/รายการมาตรฐาน (ICD-9)' },
  { code: '03', key: '03', label: 'เวชภัณฑ์มิใช่ยา' },
  { code: '04', key: '04', label: 'วัสดุคุมกำเนิด/อื่นๆ' },
  { code: '05', key: '05', label: 'วัคซีน' },
  { code: '06', key: '06', label: 'ค่าบริการคัดกรอง/ตรวจสุขภาพ' },
  { code: '07', key: '07', label: 'ค่าบริการตรวจ Lab' },
  { code: '10', key: '10', label: 'ยาสมุนไพร/แผนไทย' },
  { code: '91', key: '91', label: 'หัตถการ (ICD-9)' },
  { code: null, key: '_none', label: 'ไม่ระบุหมวด' },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
const BY_CODE = new Map(CATEGORIES.filter((c) => c.code !== null).map((c) => [c.code, c]));

// The categories offered by the dedicated "ยอดจ่ายรายวัน" (dispensing)
// export, in the order they should appear in that picker. A curated subset
// of CATEGORIES — narrower than the master-list export's category grid.
const DISPENSING_EXPORT_CATEGORY_KEYS = ['01', '10', '05', '03', '04'];

// Map a raw cdrug.drugtype value (as stored, including null/'') to its category.
function categoryFor(drugtype) {
  return BY_CODE.get(drugtype) || BY_KEY.get('_none');
}

// Resolve requested category keys to a SQL WHERE clause on drugtype.
// Returns { where, params }. Unknown keys are ignored. If `keys` is empty
// or undefined, all categories are included (no filter).
function whereForKeys(keys) {
  if (!keys || keys.length === 0) return { where: '', params: [] };
  const cats = keys.map((k) => BY_KEY.get(k)).filter(Boolean);
  if (cats.length === 0) return { where: '', params: [] };

  const codes = cats.map((c) => c.code).filter((c) => c !== null);
  const includeNone = cats.some((c) => c.key === '_none');
  const clauses = [];
  const params = [];
  if (codes.length) {
    clauses.push(`drugtype IN (${codes.map(() => '?').join(',')})`);
    params.push(...codes);
  }
  if (includeNone) clauses.push(`(drugtype IS NULL OR drugtype = '')`);
  return { where: `WHERE ${clauses.join(' OR ')}`, params };
}

// All categories with a live row count, for building the selection UI.
async function categories() {
  const [rows] = await db.pool.query(
    `SELECT drugtype, COUNT(*) n FROM cdrug GROUP BY drugtype`
  );
  const counts = new Map();
  let noneCount = 0;
  for (const r of rows) {
    if (r.drugtype === null || r.drugtype === '') noneCount += Number(r.n);
    else counts.set(r.drugtype, Number(r.n));
  }
  return CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    count: c.key === '_none' ? noneCount : counts.get(c.code) || 0,
  })).filter((c) => c.count > 0);
}

// The master list for the requested category keys. Each row carries the four
// requested export columns plus the category key/label for grouping.
//   code  -> รหัสยา-เวชภัณฑ์ (cdrug.drugcode)
//   name  -> ชื่อยา (cdrug.drugname, exactly as stored in the database)
//   cost  -> ราคาทุน (cdrug.cost)
//   sell  -> ราคาขาย (cdrug.sell)
async function list(keys) {
  const { where, params } = whereForKeys(keys);
  const [rows] = await db.pool.query(
    `SELECT drugcode AS code,
            drugname AS name,
            cost, sell,
            drugtype
     FROM cdrug
     ${where}
     ORDER BY drugtype, drugname`,
    params
  );
  return rows.map((r) => {
    const cat = categoryFor(r.drugtype);
    return {
      code: r.code,
      name: r.name === null ? '' : r.name,
      cost: r.cost === null ? null : Number(r.cost),
      sell: r.sell === null ? null : Number(r.sell),
      categoryKey: cat.key,
      categoryLabel: cat.label,
    };
  });
}

// Every drug dispensed within a date range (inclusive), one row per
// visitdrug line. Pass dateFrom === dateTo for a single day.
// keys: category keys to restrict to (same as list()); empty/undefined = all.
// codes: exact drugcode values to restrict to (optional); empty/undefined =
//   no code filter (used by the "ยอดจ่ายรายวัน" export, which requires
//   picking specific drug items rather than a whole category).
//   date       -> visit.visitdate
//   time       -> visit.timestart
//   visitno    -> visit.visitno
//   pid        -> visit.pid
//   patientName-> person prename+fname+lname
//   code       -> visitdrug.drugcode
//   name       -> cdrug.drugname
//   qty        -> visitdrug.unit
//   amount     -> visitdrug.realprice
async function transactionsForDate(dateFrom, dateTo, keys, codes) {
  const { where, params } = whereForKeys(keys);
  const catFilter = where ? where.replace('WHERE ', 'AND (') + ')' : '';
  const codesFilter = codes && codes.length ? ` AND vd.drugcode IN (${codes.map(() => '?').join(',')})` : '';
  const codesParams = codes && codes.length ? codes : [];
  const [rows] = await db.pool.query(
    `SELECT v.visitdate       AS date,
            v.timestart       AS time,
            v.visitno         AS visitno,
            v.pid             AS pid,
            pn.prename        AS pre,
            p.fname           AS fname,
            p.lname           AS lname,
            vd.drugcode       AS code,
            c.drugname        AS name,
            c.drugtype        AS drugtype,
            vd.unit           AS qty,
            vd.realprice      AS amount
     FROM visitdrug vd
     JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
     LEFT JOIN cdrug c ON c.drugcode = vd.drugcode
     LEFT JOIN person p ON p.pcucodeperson = v.pcucodeperson AND p.pid = v.pid
     LEFT JOIN _tmpprename_code pn ON pn.prenamecode = p.prename
     WHERE v.visitdate BETWEEN ? AND ? ${catFilter}${codesFilter}
     ORDER BY v.visitdate, c.drugtype, c.drugname, v.timestart, v.visitno`,
    [dateFrom, dateTo, ...params, ...codesParams]
  );
  return rows.map((r) => {
    const cat = categoryFor(r.drugtype);
    return {
      date: r.date,
      time: r.time || '',
      visitno: r.visitno,
      pid: r.pid,
      patientName: `${r.pre || ''}${r.fname || ''} ${r.lname || ''}`.trim() || '(ไม่พบชื่อ)',
      code: r.code,
      name: r.name === null ? '' : r.name,
      qty: r.qty === null ? 0 : Number(r.qty),
      amount: r.amount === null ? null : Number(r.amount),
      categoryKey: cat.key,
      categoryLabel: cat.label,
    };
  });
}

// Collapse dispensing lines (from transactionsForDate) into one row per drug:
// how many distinct patients received it and how much was dispensed in total.
//   patientCount -> COUNT(DISTINCT pid)
//   qty          -> SUM(unit)
//   amount       -> SUM(realprice)
function aggregateByDrug(txRows) {
  const byDrug = new Map();
  for (const r of txRows) {
    if (!byDrug.has(r.code)) {
      byDrug.set(r.code, {
        code: r.code,
        name: r.name,
        categoryKey: r.categoryKey,
        categoryLabel: r.categoryLabel,
        patients: new Set(),
        qty: 0,
        amount: 0,
      });
    }
    const g = byDrug.get(r.code);
    g.patients.add(r.pid);
    g.qty += r.qty;
    g.amount += r.amount || 0;
  }
  return [...byDrug.values()].map((g) => ({
    code: g.code,
    name: g.name,
    categoryKey: g.categoryKey,
    categoryLabel: g.categoryLabel,
    patientCount: g.patients.size,
    qty: g.qty,
    amount: g.amount,
  }));
}

module.exports = {
  CATEGORIES,
  DISPENSING_EXPORT_CATEGORY_KEYS,
  categories,
  list,
  whereForKeys,
  transactionsForDate,
  aggregateByDrug,
};
