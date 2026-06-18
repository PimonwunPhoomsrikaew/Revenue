// CLI: export the drug/medical-supply master list to an .xlsx file.
//
// Usage:
//   node export-drugs.js                 # all categories -> drugs-export.xlsx
//   node export-drugs.js 01 03 05        # only the given category keys
//   node export-drugs.js --list          # show available categories + counts
//   node export-drugs.js 01 -o ยา.xlsx   # custom output filename
//
// Category keys are the cdrug.drugtype codes (01,02,03,04,05,06,07,10,91)
// plus "_none" for items with no type. See drugs.js for the Thai labels.

const drugs = require('./drugs');
const { buildWorkbook } = require('./drug-export');
const db = require('./db');

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--list') || argv.includes('-l')) {
    const cats = await drugs.categories();
    console.log('หมวดที่มีในระบบ (key  จำนวน  ชื่อหมวด):');
    for (const c of cats) console.log(`  ${c.key.padEnd(6)} ${String(c.count).padStart(5)}  ${c.label}`);
    return;
  }

  let out = 'drugs-export.xlsx';
  const keys = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--out') out = argv[++i];
    else keys.push(argv[i]);
  }

  const rows = await drugs.list(keys);
  if (rows.length === 0) {
    console.error('ไม่พบรายการสำหรับหมวดที่เลือก');
    process.exit(1);
  }
  const wb = buildWorkbook(rows);
  await wb.xlsx.writeFile(out);
  console.log(`สร้างไฟล์สำเร็จ: ${out}  (${rows.length} รายการ${keys.length ? `, หมวด: ${keys.join(', ')}` : ', ทุกหมวด'})`);
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
