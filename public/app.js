const fromEl = document.getElementById('from');
const toEl = document.getElementById('to');
let chart;
let trendChart;
let currentDaily = [];

// One distinct colour per PPFS line (order matches the server's series order).
const TREND_COLORS = [
  '#e6194b', '#3cb44b', '#f58231', '#4363d8', '#911eb4',
  '#42d4f4', '#bfa100', '#f032e6', '#469990', '#9a6324',
];

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function setDefaultRange() {
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - 29);
  fromEl.value = fmt(start);
  toEl.value = fmt(today);
}

function showLoading() {
  document.getElementById('loading').classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loading').classList.add('hidden');
}

async function api(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('unauthorized');
  }
  return res.json();
}

async function loadDaily() {
  showLoading();
  try {
    const data = await api(`/api/daily?from=${fromEl.value}&to=${toEl.value}`);
    if (data.error) throw new Error(data.error);
    currentDaily = data.data;
    renderSummary(data.data);
    renderChart(data.data);
    const trend = await api(`/api/category-trend?from=${fromEl.value}&to=${toEl.value}`);
    if (trend.error) throw new Error(trend.error);
    renderTrend(trend);
    document.getElementById('detail').classList.add('hidden');
  } catch (e) {
    if (e.message === 'unauthorized') return;
    alert('โหลดข้อมูลไม่สำเร็จ: ' + e.message + ' — กรุณาลองอีกครั้ง');
  } finally {
    hideLoading();
  }
}

function renderSummary(rows) {
  const totalPatients = rows.reduce((s, r) => s + Number(r.patients), 0);
  const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
  document.getElementById('sumPatients').textContent = totalPatients.toLocaleString();
  document.getElementById('sumRevenue').textContent = totalRevenue.toLocaleString();
}

function renderChart(rows) {
  const labels = rows.map((r) => r.date);
  const values = rows.map((r) => Number(r.patients));
  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'จำนวนผู้รับบริการ (คน)',
        data: values,
        backgroundColor: '#2f80ed',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, els) => {
        if (els.length) loadPatients(labels[els[0].index]);
      },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: { legend: { display: false } },
    },
  });
}

function renderTrend(trend) {
  const datasets = trend.series.map((s, i) => ({
    label: s.label,
    data: s.data,
    borderColor: TREND_COLORS[i % TREND_COLORS.length],
    backgroundColor: TREND_COLORS[i % TREND_COLORS.length],
    borderWidth: 2,
    pointRadius: trend.dates.length > 60 ? 0 : 2,
    tension: 0.3,
  }));
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data: { labels: trend.dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { enabled: true },
      },
    },
  });
}

function renderCategories(categories) {
  const wrap = document.getElementById('catSummary');
  wrap.innerHTML = '';
  if (!categories || !categories.length) return;
  wrap.innerHTML =
    '<div class="cat-title">สรุปรายการบริการ</div>' +
    '<div class="cat-grid">' +
    categories
      .map(
        (c) =>
          `<div class="cat-chip"><div class="cat-count">${c.count}</div>` +
          `<div class="cat-label">${c.label}</div></div>`
      )
      .join('') +
    '</div>';
}

async function loadPatients(date) {
  showLoading();
  try {
    const data = await api(`/api/patients?date=${date}`);
    if (data.error) throw new Error(data.error);
    const detail = document.getElementById('detail');
    const revenue = Number(data.revenue || 0).toLocaleString();
    document.getElementById('detailTitle').textContent =
      `ผู้รับบริการวันที่ ${date} — ${data.count} คน · รายได้ ${revenue} บาท`;
    renderCategories(data.categories);
    const body = document.getElementById('detailBody');
    body.innerHTML = '';
    data.patients.forEach((p, i) => {
      const tr = document.createElement('tr');
      const services = (p.services && p.services.length)
        ? p.services.map((s) => `<span class="svc-tag">${s}</span>`).join(' ')
        : '<span class="svc-none">-</span>';
      tr.innerHTML = `<td>${i + 1}</td><td>${p.time || '-'}</td><td>${p.name}</td><td>${services}</td><td>${p.pid}</td>`;
      body.appendChild(tr);
    });
    detail.classList.remove('hidden');
    detail.scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    if (e.message === 'unauthorized') return;
    alert('โหลดรายชื่อผู้รับบริการไม่สำเร็จ: ' + e.message + ' — กรุณาคลิกที่วันนั้นอีกครั้ง');
  } finally {
    hideLoading();
  }
}

function exportPdf() {
  if (!currentDaily.length) {
    alert('ยังไม่มีข้อมูลให้ส่งออก กรุณากดแสดงข้อมูลก่อน');
    return;
  }
  const totalPatients = currentDaily.reduce((s, r) => s + Number(r.patients), 0);
  const totalRevenue = currentDaily.reduce((s, r) => s + Number(r.revenue || 0), 0);
  const printedAt = new Date().toLocaleString('th-TH');

  const rowsHtml = currentDaily
    .map(
      (r, i) =>
        `<tr><td class="c">${i + 1}</td><td>${r.date}</td>` +
        `<td class="c">${Number(r.patients).toLocaleString()}</td>` +
        `<td class="c">${Number(r.revenue || 0).toLocaleString()}</td></tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="th"><head><meta charset="UTF-8" />
<title>รายงานผู้รับบริการ ${fromEl.value} ถึง ${toEl.value}</title>
<style>
  * { font-family: "TH Sarabun New", "Sarabun", "Tahoma", sans-serif; }
  body { margin: 24px; color: #222; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #555; margin: 0 0 16px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #999; padding: 6px 8px; }
  th { background: #2f80ed; color: #fff; text-align: center; }
  td.c { text-align: center; }
  tfoot td { font-weight: bold; background: #f0f4ff; }
  .meta { margin-top: 12px; font-size: 11px; color: #888; }
  @media print { body { margin: 0; } }
</style></head>
<body>
  <h1>รายงานจำนวนผู้รับบริการรายวัน</h1>
  <p class="sub">ช่วงวันที่ ${fromEl.value} ถึง ${toEl.value} &nbsp;•&nbsp; รวม ${currentDaily.length} วัน</p>
  <table>
    <thead>
      <tr><th>#</th><th>วันที่</th><th>จำนวนผู้รับบริการ (คน)</th><th>รายได้ (บาท)</th></tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr><td colspan="2" class="c">รวมทั้งหมด</td>
      <td class="c">${totalPatients.toLocaleString()}</td>
      <td class="c">${totalRevenue.toLocaleString()}</td></tr>
    </tfoot>
  </table>
  <p class="meta">พิมพ์เมื่อ ${printedAt} — JHCIS Dashboard</p>
  <script>window.onload = function () { window.print(); };<\/script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) {
    alert('เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาต popup แล้วลองอีกครั้ง');
    return;
  }
  w.document.write(html);
  w.document.close();
}

function exportScreening() {
  // Download the screening patient list for the selected range as an .xlsx file.
  // A plain navigation lets the browser handle the file download (with cookies).
  window.location.href =
    `/api/screening/export?from=${fromEl.value}&to=${toEl.value}`;
}

document.getElementById('exportScreening').addEventListener('click', exportScreening);
document.getElementById('exportPdf').addEventListener('click', exportPdf);
document.getElementById('apply').addEventListener('click', loadDaily);
document.getElementById('last30').addEventListener('click', () => { setDefaultRange(); loadDaily(); });
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

(async () => {
  const me = await api('/api/me');
  if (!me.user) { location.href = '/login.html'; return; }
  document.getElementById('who').textContent = `ผู้ใช้: ${me.user}`;
  setDefaultRange();
  loadDaily();
})();
