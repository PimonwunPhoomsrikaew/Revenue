const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const db = require('./db');
const drugs = require('./drugs');
const { buildWorkbook, buildDispensingWorkbook } = require('./drug-export');
const { buildWorkbook: buildPatientWorkbook } = require('./patient-export');

const app = express();
app.use(express.json());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---- Auth ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === config.appUser && password === config.appPass) {
    req.session.user = username;
    return res.json({ ok: true, user: username });
  }
  return res.status(401).json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: (req.session && req.session.user) || null });
});

// ---- Data ----
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get('/api/daily', requireAuth, async (req, res) => {
  try {
    let { from, to } = req.query;
    if (!DATE_RE.test(to || '')) {
      to = new Date().toISOString().slice(0, 10);
    }
    if (!DATE_RE.test(from || '')) {
      const d = new Date(to);
      d.setDate(d.getDate() - 29);
      from = d.toISOString().slice(0, 10);
    }
    const rows = await db.dailyCounts(from, to);
    res.json({ from, to, data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-day counts of the 13 PPFS categories over a range, for the trend chart.
app.get('/api/category-trend', requireAuth, async (req, res) => {
  try {
    let { from, to } = req.query;
    if (!DATE_RE.test(to || '')) {
      to = new Date().toISOString().slice(0, 10);
    }
    if (!DATE_RE.test(from || '')) {
      const d = new Date(to);
      d.setDate(d.getDate() - 29);
      from = d.toISOString().slice(0, 10);
    }
    const trend = await db.categoryDailyCounts(from, to);
    res.json({ from, to, ...trend });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Whole-year totals of the 13 PPFS categories for calendar years 2024-2026
// (พ.ศ. 2567-2569), for the yearly grouped-bar summary.
app.get('/api/category-yearly', requireAuth, async (req, res) => {
  try {
    const yearly = await db.categoryYearlyCounts([2024, 2025, 2026]);
    res.json(yearly);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/patients', requireAuth, async (req, res) => {
  try {
    const { date } = req.query;
    if (!DATE_RE.test(date || '')) {
      return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)' });
    }
    const [rows, cat] = await Promise.all([
      db.patientsOnDay(date),
      db.categoryCounts(date),
    ]);
    res.json({
      date,
      count: rows.length,
      categories: cat.categories,
      revenue: cat.revenue,
      patients: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export the patient list for the three screening services (Z13.0 ยาเสริมธาตุเหล็ก,
// Z11.5 HPV, Z12.1 Fit test) over a date range as an .xlsx file, one sheet each.
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/screening/export', requireAuth, async (req, res) => {
  try {
    let { from, to } = req.query;
    if (!DATE_RE.test(to || '')) {
      to = new Date().toISOString().slice(0, 10);
    }
    if (!DATE_RE.test(from || '')) {
      const d = new Date(to);
      d.setDate(d.getDate() - 29);
      from = d.toISOString().slice(0, 10);
    }
    const rows = await db.screeningPatients(from, to);
    const wb = buildPatientWorkbook(rows, from, to);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="screening-${from}_${to}.xlsx"`
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Drug / medical-supply master (ERP foundation) ----

// Categories with live counts, for the selection UI.
app.get('/api/drug-categories', requireAuth, async (req, res) => {
  try {
    res.json({ categories: await drugs.categories() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The curated 5-category subset (+ live counts) offered by the dedicated
// "ยอดจ่ายรายวัน" export picker, in its fixed display order.
app.get('/api/drug-categories/dispensing', requireAuth, async (req, res) => {
  try {
    const all = await drugs.categories();
    const byKey = new Map(all.map((c) => [c.key, c]));
    const categories = drugs.DISPENSING_EXPORT_CATEGORY_KEYS
      .map((key) => byKey.get(key))
      .filter(Boolean);
    res.json({ categories });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// JSON preview of the master list for the selected categories.
// ?types=01,03,05  (omit for all categories)
app.get('/api/drugs', requireAuth, async (req, res) => {
  try {
    const keys = (req.query.types || '').split(',').map((s) => s.trim()).filter(Boolean);
    const rows = await drugs.list(keys);
    res.json({ count: rows.length, drugs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolves the from/to range for the drug summary/export endpoints.
// Accepts ?from=&to= (range) or the legacy single ?date=. Returns null if
// no valid range was given.
function drugDateRange(query) {
  const from = query.from || query.date;
  const to = query.to || query.date;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) return null;
  return { from, to };
}

// Per-drug summary for a date range: how many patients received each drug
// and how much was dispensed in total. ?from=YYYY-MM-DD&to=YYYY-MM-DD&types=01,03
// (or the legacy ?date=YYYY-MM-DD for a single day).
app.get('/api/drugs/summary', requireAuth, async (req, res) => {
  try {
    const range = drugDateRange(req.query);
    if (!range) {
      return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง หรือช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD)' });
    }
    const keys = (req.query.types || '').split(',').map((s) => s.trim()).filter(Boolean);
    const txRows = await drugs.transactionsForDate(range.from, range.to, keys);
    const summary = drugs
      .aggregateByDrug(txRows)
      .sort((a, b) => a.categoryKey.localeCompare(b.categoryKey) || a.name.localeCompare(b.name));
    res.json({ from: range.from, to: range.to, count: summary.length, drugs: summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download the selected categories as an .xlsx file.
// ?types=01,03,05  (omit for all categories)
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (optional, or legacy ?date=) also appends a
// per-category sheet with that range's dispensing transactions (summary +
// per-visit detail).
app.get('/api/drugs/export', requireAuth, async (req, res) => {
  try {
    const keys = (req.query.types || '').split(',').map((s) => s.trim()).filter(Boolean);
    const range = drugDateRange(req.query);
    const [rows, transactions] = await Promise.all([
      drugs.list(keys),
      range ? drugs.transactionsForDate(range.from, range.to, keys) : Promise.resolve(undefined),
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบรายการสำหรับหมวดที่เลือก' });
    }
    const dateLabel = range && (range.from === range.to ? range.from : `${range.from} ถึง ${range.to}`);
    const fileSuffix = range && (range.from === range.to ? `-${range.from}` : `-${range.from}_to_${range.to}`);
    const wb = buildWorkbook(rows, range ? { dateLabel, transactions } : undefined);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="drugs-export${fileSuffix || ''}.xlsx"`
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dedicated "ยอดจ่ายรายวัน" export: a per-drug summary + per-visit detail
// for explicitly selected drug items over a date range. Unlike
// /api/drugs/export, this always requires specific drug codes (no
// whole-category export) and never bundles the master price-list sheets.
// ?codes=1ace,Acyc800&from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/drugs/dispensing-export', requireAuth, async (req, res) => {
  try {
    const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (codes.length === 0) {
      return res.status(400).json({ error: 'กรุณาเลือกรายการยาที่ต้องการ Export' });
    }
    const range = drugDateRange(req.query);
    if (!range) {
      return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง หรือช่วงวันที่ไม่ถูกต้อง (YYYY-MM-DD)' });
    }
    const transactions = await drugs.transactionsForDate(range.from, range.to, [], codes);
    const dateLabel = range.from === range.to ? range.from : `${range.from} ถึง ${range.to}`;
    const fileSuffix = range.from === range.to ? range.from : `${range.from}_to_${range.to}`;
    const wb = buildDispensingWorkbook(transactions, dateLabel);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="yodjaiyarayvun-${fileSuffix}.xlsx"`
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Start listening and return the http.Server. Exported so the Electron
// wrapper (electron-main.js) can boot the same server in-process; still
// auto-starts when this file is run directly with `node server.js`.
function start() {
  return app.listen(config.port, () => {
    console.log(`Revenue running at http://localhost:${config.port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
