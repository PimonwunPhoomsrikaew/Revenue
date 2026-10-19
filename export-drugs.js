// CLI: export the drug/medical-supply master list to an .xlsx file.
//
// Usage:
//   node export-drugs.js                 # all categories -> drugs-export.xlsx
//   node export-drugs.js 01 03 05        # only the given category keys
//   node export-drugs.js --list          # show available categories + counts
//   node export-drugs.js 01 -o ยา.xlsx   # custom output filename
//   node export-drugs.js --date 2026-08-21   # also append per-category
//                                              transaction sheets for that day
//   node export-drugs.js --branch 41319  # target a specific JHCIS branch
//                                              (defaults to the first branch
//                                              in .env's BRANCH_CODES)
//
// Category keys are the cdrug.drugtype codes (01,02,03,04,05,06,07,10,91)
// plus "_none" for items with no type. See drugs.js for the Thai labels.

const drugs = require('./drugs');
const { buildWorkbook } = require('./drug-export');
const db = require('./db');
const config = require('./config');

async function main() {
  const argv = process.argv.slice(2);

  let out = 'drugs-export.xlsx';
  let date;
  let branchId = config.branches[0] && config.branches[0].id;
  const keys = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--date') date = argv[++i];
    else if (argv[i] === '--branch' || argv[i] === '-b') branchId = argv[++i];
    else if (argv[i] === '--list' || argv[i] === '-l') continue;
    else keys.push(argv[i]);
  }
  if (!config.branches.some((b) => b.id === branchId)) {
    console.error(`ไม่พบสาขา "${branchId}" ใน .env — สาขาที่มี: ${config.branches.map((b) => b.id).join(', ')}`);
    process.exit(1);
  }

  if (argv.includes('--list') || argv.includes('-l')) {
    const cats = await drugs.categories(branchId);
    console.log('หมวดที่มีในระบบ (key  จำนวน  ชื่อหมวด):');
    for (const c of cats) console.log(`  ${c.key.padEnd(6)} ${String(c.count).padStart(5)}  ${c.label}`);
    return;
  }

  const rows = await drugs.list(branchId, keys);
  if (rows.length === 0) {
    console.error('ไม่พบรายการสำหรับหมวดที่เลือก');
    process.exit(1);
  }
  const transactions = date ? await drugs.transactionsForDate(branchId, date, date, keys) : undefined;
  const wb = buildWorkbook(rows, date ? { dateLabel: date, transactions } : undefined);
  await wb.xlsx.writeFile(out);
  console.log(`สร้างไฟล์สำเร็จ: ${out}  (${rows.length} รายการ${keys.length ? `, หมวด: ${keys.join(', ')}` : ', ทุกหมวด'}${date ? `, ทรานแซคชันวันที่ ${date}` : ''})`);
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
  .finally(() => db.closeAll());
