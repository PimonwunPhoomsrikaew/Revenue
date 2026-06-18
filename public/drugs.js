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

function exportXlsx() {
  const types = selectedKeys().join(',');
  // Let the browser handle the file download via the authenticated session.
  window.location.href = `/api/drugs/export?types=${encodeURIComponent(types)}`;
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
document.getElementById('export').addEventListener('click', exportXlsx);
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

(async () => {
  const me = await api('/api/me');
  if (!me.user) { location.href = '/login.html'; return; }
  document.getElementById('who').textContent = `ผู้ใช้: ${me.user}`;
  await loadCategories();
})();
