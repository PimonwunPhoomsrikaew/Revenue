// Drug / medical-supply export page: pick categories, preview, download .xlsx.

function showLoading() { document.getElementById('loading').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading').classList.add('hidden'); }

async function api(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('unauthorized');
  }
  return res.json();
}

// Currently-checked category keys.
function selectedKeys() {
  return [...document.querySelectorAll('.cat-check:checked')].map((c) => c.value);
}

function refreshSelInfo() {
  const boxes = [...document.querySelectorAll('.cat-check')];
  const checked = boxes.filter((c) => c.checked);
  const total = checked.reduce((s, c) => s + Number(c.dataset.count), 0);
  const info = document.getElementById('selInfo');
  if (checked.length === 0) {
    info.textContent = 'ยังไม่ได้เลือกหมวด (ถ้า Export โดยไม่เลือก = ทุกหมวด)';
  } else {
    info.textContent = `เลือก ${checked.length} หมวด • รวม ${total.toLocaleString()} รายการ`;
  }
}

async function loadCategories() {
  const grid = document.getElementById('catGrid');
  try {
    const { categories } = await api('/api/drug-categories');
    grid.innerHTML = '';
    for (const c of categories) {
      const id = `cat-${c.key}`;
      const label = document.createElement('label');
      label.className = 'cat-card';
      label.innerHTML =
        `<input type="checkbox" class="cat-check" id="${id}" value="${c.key}" data-count="${c.count}" />` +
        `<span class="cat-name">${c.label}</span>` +
        `<span class="cat-count">${c.count.toLocaleString()} รายการ</span>`;
      grid.appendChild(label);
    }
    grid.addEventListener('change', refreshSelInfo);
    refreshSelInfo();
  } catch (e) {
    grid.innerHTML = `<p class="hint">โหลดหมวดไม่สำเร็จ: ${e.message}</p>`;
  }
}

async function preview() {
  showLoading();
  try {
    const types = selectedKeys().join(',');
    const data = await api(`/api/drugs?types=${encodeURIComponent(types)}`);
    if (data.error) throw new Error(data.error);
    const body = document.getElementById('previewBody');
    body.innerHTML = '';
    const baht = (v) => (v === null ? '-' : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    data.drugs.slice(0, 200).forEach((d, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${i + 1}</td><td>${d.code}</td><td>${d.name}</td>` +
        `<td>${d.categoryLabel}</td><td style="text-align:right">${baht(d.cost)}</td>` +
        `<td style="text-align:right">${baht(d.sell)}</td>`;
      body.appendChild(tr);
    });
    document.getElementById('previewTitle').textContent =
      `ตัวอย่างรายการ (ทั้งหมด ${data.count.toLocaleString()} รายการ)`;
    document.getElementById('previewNote').textContent =
      data.count > 200 ? 'แสดง 200 รายการแรก — ไฟล์ Excel จะมีครบทุกรายการ' : '';
    document.getElementById('previewWrap').classList.remove('hidden');
  } catch (e) {
    alert('ดูตัวอย่างไม่สำเร็จ: ' + e.message);
  } finally {
    hideLoading();
  }
}

async function viewTxSummary() {
  const from = document.getElementById('txDateFrom').value;
  const to = document.getElementById('txDateTo').value;
  if (!from || !to) { alert('กรุณาเลือกช่วงวันที่ก่อน'); return; }
  if (from > to) { alert('วันเริ่มต้นต้องไม่เกินวันสิ้นสุด'); return; }
  showLoading();
  try {
    const types = selectedKeys().join(',');
    const data = await api(`/api/drugs/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&types=${encodeURIComponent(types)}`);
    if (data.error) throw new Error(data.error);
    const body = document.getElementById('txSummaryBody');
    body.innerHTML = '';
    const num = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
    data.drugs.forEach((d, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${i + 1}</td><td>${d.code}</td><td>${d.name}</td><td>${d.categoryLabel}</td>` +
        `<td style="text-align:right">${d.patientCount.toLocaleString()}</td>` +
        `<td style="text-align:right">${num(d.qty)}</td>`;
      body.appendChild(tr);
    });
    const rangeLabel = from === to ? `วันที่ ${from}` : `ช่วงวันที่ ${from} ถึง ${to}`;
    document.getElementById('txSummaryTitle').textContent =
      `ยอดจ่ายยา${rangeLabel} (${data.count.toLocaleString()} รายการยา)`;
    document.getElementById('txSummaryWrap').classList.remove('hidden');
  } catch (e) {
    alert('ดูยอดไม่สำเร็จ: ' + e.message);
  } finally {
    hideLoading();
  }
}

function exportXlsx() {
  const types = selectedKeys().join(',');
  const from = document.getElementById('txDateFrom').value;
  const to = document.getElementById('txDateTo').value;
  const remainDate = document.getElementById('remainDate').value;
  // Let the browser handle the file download via the authenticated session.
  let url = `/api/drugs/export?types=${encodeURIComponent(types)}`;
  if (from && to) url += `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (remainDate) url += `&remainDate=${encodeURIComponent(remainDate)}`;
  window.location.href = url;
}

// ---- Dedicated "ยอดจ่ายรายวัน" export: pick a category (from a fixed
// 5-category subset), then force picking specific drug items within it
// before the export is allowed. Selections persist across category/search
// changes via dispSelected (code -> { code, name }).
const dispSelected = new Map();
let dispCurrentItems = [];

function refreshDispState() {
  const info = document.getElementById('dispSelInfo');
  info.textContent = dispSelected.size === 0
    ? 'ยังไม่ได้เลือกรายการยา'
    : `เลือก ${dispSelected.size} รายการ`;

  const chipList = document.getElementById('dispChipList');
  chipList.innerHTML = '';
  for (const item of dispSelected.values()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${item.name} <span class="item-code">(${item.code})</span> <button type="button" data-code="${item.code}">×</button>`;
    chipList.appendChild(chip);
  }

  const from = document.getElementById('dispDateFrom').value;
  const to = document.getElementById('dispDateTo').value;
  document.getElementById('dispExport').disabled =
    dispSelected.size === 0 || !from || !to || from > to;
}

function renderDispItemList() {
  const search = document.getElementById('dispSearch').value.trim().toLowerCase();
  const list = document.getElementById('dispItemList');
  const filtered = search
    ? dispCurrentItems.filter((d) => d.name.toLowerCase().includes(search) || d.code.toLowerCase().includes(search))
    : dispCurrentItems;
  list.innerHTML = '';
  if (filtered.length === 0) {
    list.innerHTML = '<p class="hint">ไม่พบรายการยา</p>';
    return;
  }
  for (const d of filtered) {
    const row = document.createElement('label');
    row.className = 'item-row';
    row.innerHTML =
      `<input type="checkbox" ${dispSelected.has(d.code) ? 'checked' : ''} />` +
      `<span class="item-name">${d.name}</span><span class="item-code">${d.code}</span>`;
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) dispSelected.set(d.code, { code: d.code, name: d.name });
      else dispSelected.delete(d.code);
      refreshDispState();
    });
    list.appendChild(row);
  }
}

async function loadDispCategories() {
  const select = document.getElementById('dispCategory');
  try {
    const { categories } = await api('/api/drug-categories/dispensing');
    for (const c of categories) {
      const opt = document.createElement('option');
      opt.value = c.key;
      opt.textContent = `${c.label} (${c.count.toLocaleString()} รายการ)`;
      select.appendChild(opt);
    }
  } catch (e) {
    select.innerHTML = `<option value="">โหลดหมวดไม่สำเร็จ</option>`;
  }
}

async function onDispCategoryChange() {
  const key = document.getElementById('dispCategory').value;
  const list = document.getElementById('dispItemList');
  if (!key) {
    dispCurrentItems = [];
    list.innerHTML = '<p class="hint">เลือกหมวดเพื่อโหลดรายการยา…</p>';
    return;
  }
  list.innerHTML = '<p class="hint">กำลังโหลด…</p>';
  try {
    const data = await api(`/api/drugs?types=${encodeURIComponent(key)}`);
    if (data.error) throw new Error(data.error);
    dispCurrentItems = data.drugs;
    renderDispItemList();
  } catch (e) {
    list.innerHTML = `<p class="hint">โหลดรายการยาไม่สำเร็จ: ${e.message}</p>`;
  }
}

function exportDispensingXlsx() {
  const from = document.getElementById('dispDateFrom').value;
  const to = document.getElementById('dispDateTo').value;
  const codes = [...dispSelected.keys()].join(',');
  const url = `/api/drugs/dispensing-export?codes=${encodeURIComponent(codes)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  window.location.href = url;
}

document.getElementById('selectAll').addEventListener('click', () => {
  document.querySelectorAll('.cat-check').forEach((c) => (c.checked = true));
  refreshSelInfo();
});
document.getElementById('clearAll').addEventListener('click', () => {
  document.querySelectorAll('.cat-check').forEach((c) => (c.checked = false));
  refreshSelInfo();
});
document.getElementById('preview').addEventListener('click', preview);
document.getElementById('viewTxSummary').addEventListener('click', viewTxSummary);
document.getElementById('export').addEventListener('click', exportXlsx);
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

document.getElementById('dispCategory').addEventListener('change', onDispCategoryChange);
document.getElementById('dispSearch').addEventListener('input', renderDispItemList);
document.getElementById('dispDateFrom').addEventListener('input', refreshDispState);
document.getElementById('dispDateTo').addEventListener('input', refreshDispState);
document.getElementById('dispChipList').addEventListener('click', (e) => {
  const code = e.target.dataset.code;
  if (!code) return;
  dispSelected.delete(code);
  refreshDispState();
  renderDispItemList();
});
document.getElementById('dispExport').addEventListener('click', exportDispensingXlsx);

(async () => {
  const me = await api('/api/me');
  if (!me.user) { location.href = '/login.html'; return; }
  document.getElementById('who').textContent = me.branch
    ? `ผู้ใช้: ${me.user} — ${me.branch}`
    : `ผู้ใช้: ${me.user}`;
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('txDateFrom').value = today;
  document.getElementById('txDateTo').value = today;
  document.getElementById('dispDateFrom').value = today;
  document.getElementById('dispDateTo').value = today;
  document.getElementById('remainDate').value = today;
  await loadCategories();
  await loadDispCategories();
  refreshDispState();
})();
