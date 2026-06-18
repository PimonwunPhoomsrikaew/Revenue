const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const log = (...a) => console.log('[drive]', ...a);

  page.on('console', (m) => log('page console:', m.type(), m.text()));
  page.on('pageerror', (e) => log('PAGE ERROR:', e.message));

  // 1. Landing -> redirects to login
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  log('url after landing:', page.url());
  await page.screenshot({ path: 'shot-1-login.png' });

  // 2. Log in
  await page.fill('#username', '01088');
  await page.fill('#password', '01088*');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard.html', { timeout: 15000 });
  log('logged in, url:', page.url());

  // Wait for data + chart to render
  await page.waitForFunction(
    () => document.getElementById('sumPatients')?.textContent !== '-',
    { timeout: 20000 }
  );
  await page.waitForTimeout(800); // let chart animation settle
  await page.screenshot({ path: 'shot-2-dashboard.png' });

  const cards = await page.evaluate(() => ({
    patients: document.getElementById('sumPatients').textContent,
    visits: document.getElementById('sumVisits').textContent,
    avg: document.getElementById('avgPatients').textContent,
    peak: document.getElementById('peakDay').textContent,
    revenue: document.getElementById('sumRevenue').textContent,
  }));
  log('summary cards:', JSON.stringify(cards));

  // 3. Click the tallest bar to load that day's patient detail.
  // Drive via the same code path the chart onClick uses: pick peak date.
  const peakDate = (cards.peak.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
  log('clicking detail for peak date:', peakDate);
  await page.evaluate((d) => window.loadPatients(d), peakDate);
  await page.waitForFunction(
    () => !document.getElementById('detail').classList.contains('hidden'),
    { timeout: 15000 }
  );
  await page.waitForTimeout(500);

  const detail = await page.evaluate(() => ({
    title: document.getElementById('detailTitle').textContent,
    rows: document.querySelectorAll('#detailBody tr').length,
    firstRow: document.querySelector('#detailBody tr')?.innerText,
    cats: [...document.querySelectorAll('.cat-chip')].map((c) => c.innerText.replace(/\n/g, ' ')),
  }));
  log('detail panel:', JSON.stringify(detail));
  await page.screenshot({ path: 'shot-3-detail.png', fullPage: true });

  await browser.close();
  log('done');
})().catch((e) => { console.error('DRIVE FAILED:', e); process.exit(1); });
