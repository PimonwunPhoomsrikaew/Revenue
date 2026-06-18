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
    const cat = [...BY_KEY.values()].find((c) => c.code === r.drugtype) ||
      BY_KEY.get('_none');
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

module.exports = { CATEGORIES, categories, list, whereForKeys };
