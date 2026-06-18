const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const db = require('./db');
const drugs = require('./drugs');
const { buildWorkbook } = require('./drug-export');
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

// Per-day counts of the 10 PPFS categories over a range, for the trend chart.
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
// Z12.4 HPV, Z12.1 Fit test) over a date range as an .xlsx file, one sheet each.
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

// Download the selected categories as an .xlsx file.
// ?types=01,03,05  (omit for all categories)
app.get('/api/drugs/export', requireAuth, async (req, res) => {
  try {
    const keys = (req.query.types || '').split(',').map((s) => s.trim()).filter(Boolean);
    const rows = await drugs.list(keys);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบรายการสำหรับหมวดที่เลือก' });
    }
    const wb = buildWorkbook(rows);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="drugs-export.xlsx"'
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.port, () => {
  console.log(`JHCIS dashboard running at http://localhost:${config.port}`);
});
