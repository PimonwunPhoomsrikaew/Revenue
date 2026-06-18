const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool(config.db);

// Connection errors that mean a pooled connection went stale (server closed it
// while idle). Safe to retry once on a freshly-opened connection.
const TRANSIENT = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'EPIPE',
  'ETIMEDOUT',
]);

// pool.query wrapper that retries once when a stale connection is dropped.
async function query(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    if (TRANSIENT.has(e.code)) {
      return await pool.query(sql, params);
    }
    throw e;
  }
}

// Revenue earned per distinct person for each paid diagnosis code (baht).
const REVENUE_RATES = { z130: 80, z124: 50, z121: 60 };

// Revenue for one day's code counts, following REVENUE_RATES.
function revenueFor(counts) {
  return (
    Number(counts.z130 || 0) * REVENUE_RATES.z130 +
    Number(counts.z124 || 0) * REVENUE_RATES.z124 +
    Number(counts.z121 || 0) * REVENUE_RATES.z121
  );
}

// Patients (distinct persons) per day within an inclusive date range, with the
// per-day revenue from the three paid diagnosis codes.
async function dailyCounts(from, to) {
  const [rows] = await query(
    `SELECT v.visitdate AS date,
            COUNT(DISTINCT v.pid) AS patients,
            COUNT(DISTINCT v.visitno) AS visits,
            COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z13.0' THEN v.pid END) AS z130,
            COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.4' THEN v.pid END) AS z124,
            COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.1' THEN v.pid END) AS z121
     FROM visit v
     LEFT JOIN visitdiag vd
            ON vd.pcucode = v.pcucode AND vd.visitno = v.visitno
     WHERE v.visitdate BETWEEN ? AND ?
     GROUP BY v.visitdate
     ORDER BY v.visitdate`,
    [from, to]
  );
  return rows.map((r) => ({
    date: r.date,
    patients: Number(r.patients),
    visits: Number(r.visits),
    revenue: revenueFor(r),
  }));
}

// Short service labels shown per patient (same categories as categoryCounts).
const SERVICE_LABELS = {
  z130: 'ยาเสริมธาตุเหล็ก',
  z124: 'HPV',
  z121: 'Fit test',
  dental: 'ทันตกรรม',
  ttm: 'แพทย์แผนไทย',
};

// Patient list for a single day, with the tracked services each one received.
async function patientsOnDay(date) {
  const [rows] = await query(
    `SELECT v.visitno, v.pid, v.timestart,
            pn.prename AS pre, p.fname, p.lname,
            MAX(vd.diagcode = 'Z13.0')      AS z130,
            MAX(vd.diagcode = 'Z12.4')      AS z124,
            MAX(vd.diagcode = 'Z12.1')      AS z121,
            MAX(vd.diagcode REGEXP '^U[5-7]') AS ttm,
            MAX(dc.visitno IS NOT NULL)     AS dental
     FROM visit v
     LEFT JOIN person p
            ON p.pcucodeperson = v.pcucodeperson AND p.pid = v.pid
     LEFT JOIN _tmpprename_code pn
            ON pn.prenamecode = p.prename
     LEFT JOIN visitdiag vd
            ON vd.pcucode = v.pcucode AND vd.visitno = v.visitno
     LEFT JOIN visitdentalcheck dc
            ON dc.pcucode = v.pcucode AND dc.visitno = v.visitno
     WHERE v.visitdate = ?
     GROUP BY v.visitno, v.pid, v.timestart, pn.prename, p.fname, p.lname
     ORDER BY v.timestart, v.visitno`,
    [date]
  );
  return rows.map((r) => {
    const services = [];
    if (Number(r.z130)) services.push(SERVICE_LABELS.z130);
    if (Number(r.z124)) services.push(SERVICE_LABELS.z124);
    if (Number(r.z121)) services.push(SERVICE_LABELS.z121);
    if (Number(r.dental)) services.push(SERVICE_LABELS.dental);
    if (Number(r.ttm)) services.push(SERVICE_LABELS.ttm);
    return {
      visitno: r.visitno,
      pid: r.pid,
      time: r.timestart,
      name: `${r.pre || ''}${r.fname || ''} ${r.lname || ''}`.trim() || '(ไม่พบชื่อ)',
      services,
    };
  });
}

// Counts per service category on a single day. Each category has its own rule:
//   PRT            visitdiag Z32.0 / Z32.1                          (distinct persons)
//   HPV            visitdiag Z12.4, female, age 30–59               (distinct persons)
//   Fit Test       visitdiag Z12.1, any sex, age 50–70              (distinct persons)
//   herbal drug    visitdrug + cdrug.drugtype = '10'                (distinct persons)
//   OP anywhere    pending central process — not held in JHCIS      (placeholder)
//   iron tablets   visitdiag Z13.0, female, age 13–45               (distinct persons)
//   contraceptive pill   visitdrug.drugcode '03'                    (packs = SUM unit)
//   contraceptive inject visitdrug.drugcode 12 / DEPO-M / DEPO-M1   (distinct persons)
//   EPI vaccine    visitepi.vaccinecode, exclude COVID% and 'dT'    (doses)
//   dT vaccine     visitdiag Z23.5 / Z23.6                          (distinct persons)
// Age is taken at the visit date. Counts are per-day occurrences only — the
// screening cycle (every 5/2/1 years) is program context and is NOT enforced.
async function categoryCounts(date) {
  // Diagnosis-based categories (need person age/sex). z130/z124/z121 are kept
  // unfiltered here solely to feed the revenue calc (same basis as dailyCounts).
  const [[diag]] = await query(
    `SELECT
        COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z32.0','Z32.1') THEN v.pid END) AS prt,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.4' AND p.sex = '2'
                             AND TIMESTAMPDIFF(YEAR, p.birth, v.visitdate) BETWEEN 30 AND 59
                            THEN v.pid END) AS hpv,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.1'
                             AND TIMESTAMPDIFF(YEAR, p.birth, v.visitdate) BETWEEN 50 AND 70
                            THEN v.pid END) AS fit,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z13.0' AND p.sex = '2'
                             AND TIMESTAMPDIFF(YEAR, p.birth, v.visitdate) BETWEEN 13 AND 45
                            THEN v.pid END) AS iron,
        COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z23.5','Z23.6') THEN v.pid END) AS dt,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z13.0' THEN v.pid END) AS z130,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.4' THEN v.pid END) AS z124,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.1' THEN v.pid END) AS z121
     FROM visit v
     LEFT JOIN person p
            ON p.pcucodeperson = v.pcucodeperson AND p.pid = v.pid
     LEFT JOIN visitdiag vd
            ON vd.pcucode = v.pcucode AND vd.visitno = v.visitno
     WHERE v.visitdate = ?`,
    [date]
  );
  // Drug-based categories: herbal (by drugtype), contraceptive pill (packs) and
  // injection (persons), all from visitdrug joined to the drug master.
  const [[drug]] = await query(
    `SELECT
        COUNT(DISTINCT CASE WHEN c.drugtype = '10' THEN v.pid END) AS herbal,
        COALESCE(SUM(CASE WHEN dr.drugcode = '03' THEN dr.unit ELSE 0 END), 0) AS pills,
        COUNT(DISTINCT CASE WHEN dr.drugcode IN ('12','DEPO-M','DEPO-M1')
                            THEN v.pid END) AS inject
     FROM visit v
     JOIN visitdrug dr
            ON dr.pcucode = v.pcucode AND dr.visitno = v.visitno
     LEFT JOIN cdrug c ON c.drugcode = dr.drugcode
     WHERE v.visitdate = ?`,
    [date]
  );
  // EPI vaccine doses, excluding COVID series and dT (dT is counted separately).
  const [[epi]] = await query(
    `SELECT COUNT(*) AS n
     FROM visit v
     JOIN visitepi e ON e.pcucode = v.pcucode AND e.visitno = v.visitno
     WHERE v.visitdate = ?
       AND e.vaccinecode NOT LIKE 'COVID%'
       AND e.vaccinecode <> 'dT'`,
    [date]
  );
  const categories = [
    { key: 'prt', label: 'ทดสอบการตั้งครรภ์ (PRT)', count: Number(diag.prt) },
    { key: 'hpv', label: 'มะเร็งปากมดลูก (HPV)', count: Number(diag.hpv) },
    { key: 'fit', label: 'มะเร็งลำไส้ (Fit Test)', count: Number(diag.fit) },
    { key: 'herbal', label: 'จ่ายยาสมุนไพร', count: Number(drug.herbal) },
    { key: 'opanywhere', label: 'OP anywhere (รอประมวลผลส่วนกลาง)', count: 'รอ' },
    { key: 'iron', label: 'ยาเสริมธาตุเหล็ก', count: Number(diag.iron) },
    { key: 'pill', label: 'ยาเม็ดคุมกำเนิด (แผง)', count: Number(drug.pills) },
    { key: 'inject', label: 'ยาฉีดคุมกำเนิด (คน)', count: Number(drug.inject) },
    { key: 'epi', label: 'วัคซีน EPI (โดส)', count: Number(epi.n) },
    { key: 'dt', label: 'วัคซีน dT', count: Number(diag.dt) },
  ];
  return { categories, revenue: revenueFor(diag) };
}

// The 10 PPFS categories, in display order. Shared by the daily-trend chart so
// the line series stay aligned with the per-day category panel. 'opanywhere' has
// no JHCIS source (pending central process) and is always 0 in the trend.
const PPFS_CATEGORIES = [
  { key: 'prt', label: 'ทดสอบการตั้งครรภ์ (PRT)' },
  { key: 'hpv', label: 'มะเร็งปากมดลูก (HPV)' },
  { key: 'fit', label: 'มะเร็งลำไส้ (Fit Test)' },
  { key: 'herbal', label: 'จ่ายยาสมุนไพร' },
  { key: 'opanywhere', label: 'OP anywhere' },
  { key: 'iron', label: 'ยาเสริมธาตุเหล็ก' },
  { key: 'pill', label: 'ยาเม็ดคุมกำเนิด (แผง)' },
  { key: 'inject', label: 'ยาฉีดคุมกำเนิด' },
  { key: 'epi', label: 'วัคซีน EPI (โดส)' },
  { key: 'dt', label: 'วัคซีน dT' },
];

// Per-day counts of the 10 PPFS categories across an inclusive date range, for
// the daily-trend line chart. Same per-category rules as categoryCounts(), but
// grouped by visitdate. Returns aligned { dates, series } where each series is
// one line: { key, label, data[] } indexed to dates.
async function categoryDailyCounts(from, to) {
  const [diag] = await query(
    `SELECT v.visitdate AS date,
        COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z32.0','Z32.1') THEN v.pid END) AS prt,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.4' AND p.sex = '2'
                             AND TIMESTAMPDIFF(YEAR, p.birth, v.visitdate) BETWEEN 30 AND 59
                            THEN v.pid END) AS hpv,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z12.1'
                             AND TIMESTAMPDIFF(YEAR, p.birth, v.visitdate) BETWEEN 50 AND 70
                            THEN v.pid END) AS fit,
        COUNT(DISTINCT CASE WHEN vd.diagcode = 'Z13.0' AND p.sex = '2'
                             AND TIMESTAMPDIFF(YEAR, p.birth, v.visitdate) BETWEEN 13 AND 45
                            THEN v.pid END) AS iron,
        COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z23.5','Z23.6') THEN v.pid END) AS dt
     FROM visit v
     LEFT JOIN person p
            ON p.pcucodeperson = v.pcucodeperson AND p.pid = v.pid
     LEFT JOIN visitdiag vd
            ON vd.pcucode = v.pcucode AND vd.visitno = v.visitno
     WHERE v.visitdate BETWEEN ? AND ?
     GROUP BY v.visitdate`,
    [from, to]
  );
  const [drug] = await query(
    `SELECT v.visitdate AS date,
        COUNT(DISTINCT CASE WHEN c.drugtype = '10' THEN v.pid END) AS herbal,
        COALESCE(SUM(CASE WHEN dr.drugcode = '03' THEN dr.unit ELSE 0 END), 0) AS pill,
        COUNT(DISTINCT CASE WHEN dr.drugcode IN ('12','DEPO-M','DEPO-M1')
                            THEN v.pid END) AS inject
     FROM visit v
     JOIN visitdrug dr
            ON dr.pcucode = v.pcucode AND dr.visitno = v.visitno
     LEFT JOIN cdrug c ON c.drugcode = dr.drugcode
     WHERE v.visitdate BETWEEN ? AND ?
     GROUP BY v.visitdate`,
    [from, to]
  );
  const [epi] = await query(
    `SELECT v.visitdate AS date, COUNT(*) AS epi
     FROM visit v
     JOIN visitepi e ON e.pcucode = v.pcucode AND e.visitno = v.visitno
     WHERE v.visitdate BETWEEN ? AND ?
       AND e.vaccinecode NOT LIKE 'COVID%'
       AND e.vaccinecode <> 'dT'
     GROUP BY v.visitdate`,
    [from, to]
  );

  const blank = () => ({
    prt: 0, hpv: 0, fit: 0, herbal: 0, opanywhere: 0,
    iron: 0, pill: 0, inject: 0, epi: 0, dt: 0,
  });
  const byDate = new Map();
  const at = (d) => {
    if (!byDate.has(d)) byDate.set(d, blank());
    return byDate.get(d);
  };
  diag.forEach((r) => {
    const o = at(r.date);
    o.prt = Number(r.prt); o.hpv = Number(r.hpv); o.fit = Number(r.fit);
    o.iron = Number(r.iron); o.dt = Number(r.dt);
  });
  drug.forEach((r) => {
    const o = at(r.date);
    o.herbal = Number(r.herbal); o.pill = Number(r.pill); o.inject = Number(r.inject);
  });
  epi.forEach((r) => { at(r.date).epi = Number(r.epi); });

  const dates = [...byDate.keys()].sort();
  const series = PPFS_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    data: dates.map((d) => byDate.get(d)[c.key]),
  }));
  return { dates, series };
}

// The three paid screening diagnoses, in export display order. Each becomes one
// worksheet in the patient-list export.
const SCREENING_CODES = [
  { code: 'Z13.0', key: 'z130', label: 'ยาเสริมธาตุเหล็ก' },
  { code: 'Z12.4', key: 'z124', label: 'HPV' },
  { code: 'Z12.1', key: 'z121', label: 'Fit test' },
];

// Every patient visit carrying one of the three screening diagnoses within an
// inclusive date range. One row per (visit, diagnosis) — a patient who received
// two of the services on the same visit appears once under each. Rows are
// returned flat with the diagcode so callers can group them into per-service
// sheets.
async function screeningPatients(from, to) {
  const codes = SCREENING_CODES.map((c) => c.code);
  const [rows] = await query(
    `SELECT DISTINCT
            vd.diagcode               AS diagcode,
            v.visitdate               AS date,
            v.timestart               AS time,
            v.visitno                 AS visitno,
            v.pid                     AS pid,
            pn.prename                AS pre,
            p.fname                   AS fname,
            p.lname                   AS lname
     FROM visit v
     JOIN visitdiag vd
            ON vd.pcucode = v.pcucode AND vd.visitno = v.visitno
           AND vd.diagcode IN (?, ?, ?)
     LEFT JOIN person p
            ON p.pcucodeperson = v.pcucodeperson AND p.pid = v.pid
     LEFT JOIN _tmpprename_code pn
            ON pn.prenamecode = p.prename
     WHERE v.visitdate BETWEEN ? AND ?
     ORDER BY vd.diagcode, v.visitdate, v.timestart, v.visitno`,
    [...codes, from, to]
  );
  return rows.map((r) => ({
    diagcode: r.diagcode,
    date: r.date,
    time: r.time,
    visitno: r.visitno,
    pid: r.pid,
    name: `${r.pre || ''}${r.fname || ''} ${r.lname || ''}`.trim() || '(ไม่พบชื่อ)',
  }));
}

module.exports = {
  pool,
  dailyCounts,
  patientsOnDay,
  categoryCounts,
  categoryDailyCounts,
  screeningPatients,
  SCREENING_CODES,
  REVENUE_RATES,
};
