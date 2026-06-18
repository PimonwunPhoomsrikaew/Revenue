/**
 * JHCIS → LINE : รายงานยอด PPFS รายวัน (Flex Message)
 * ----------------------------------------------------------------------------
 * อ่านยอด PPFS ที่ "จ่ายได้วันนี้" จากฐานข้อมูล JHCIS (MySQL) ผ่าน JDBC
 *
 * รายการ PPFS:
 *   1) ทดสอบการตั้งครรภ์ (PRT)   75  ← Z32.0, Z32.1 (นับทุกคนที่ได้รับวันนี้)
 *   2) มะเร็งปากมดลูก (HPV)      50  ← Z12.4 | อายุ 30-59 | ตรวจทุก 5 ปี → จ่ายเฉพาะคนไม่เคยในรอบ
 *   3) มะเร็งลำไส้ (Fit Test)    60  ← Z12.1 | อายุ 50-70 | ตรวจทุก 2 ปี → จ่ายเฉพาะคนไม่เคยในรอบ
 *   4) จ่ายยาสมุนไพร            (อยู่ระหว่างประมวลผล)
 *   5) OP anywhere             (อยู่ระหว่างประมวลผล)
 *   6) ยาเสริมธาตุเหล็ก          80  ← Z13.0 | อายุ 13-45 | รับได้ทุก 1 ปี → จ่ายเฉพาะคนไม่เคยในรอบ
 *   7) ยาเม็ดคุมกำเนิด        40/แผง ← จ่ายยาเม็ดคุม (นับจำนวนแผง)
 *   8) ยาฉีดคุมกำเนิด           60  ← จ่ายยาฉีดคุม (DEPO/MEDROXY)
 *   9) วัคซีน EPI               20  ← ตาราง visitepi (ยกเว้น COVID/dT)
 *  10) วัคซีน dT                20  ← Z23.5, Z23.6
 *
 * "ไม่เคยในรอบ" = ไม่เคยมีรหัสนี้ภายในช่วงรอบที่กำหนด (ก่อนวันนี้) → ถึงเคลม PPFS ได้
 * ----------------------------------------------------------------------------
 */

// ====== 1) ฐานข้อมูล JHCIS ======
var DB = { host: '183.88.232.251', port: 3333, name: 'jhcisdb01088', user: 'db01088', pass: '@jhcis01088*' };

// ====== 2) LINE Messaging API ======
// ⚠️ แนะนำเก็บ token ใน Script Properties ไม่ hardcode จริงในไฟล์
var LINE_TOKEN = 'ใส่_CHANNEL_ACCESS_TOKEN_ที่นี่';
var LINE_TARGET_ID = 'ใส่_USER_หรือ_GROUP_ID_ที่นี่';

// ====== 3) เรต PPFS (บาท) ======
var PPFS = { prt: 75, hpv: 50, fit: 60, iron: 80, pill: 40, inject: 60, epi: 20, dt: 20 };

// ====== 4) เงื่อนไขรายการคัดกรอง (อายุ + รอบการตรวจเป็นปี) ======
var SCREEN = {
  iron: { code: 'Z13.0', ageLo: 13, ageHi: 45, cycle: 1, rate: 80 },
  hpv:  { code: 'Z12.4', ageLo: 30, ageHi: 59, cycle: 5, rate: 50 },
  fit:  { code: 'Z12.1', ageLo: 50, ageHi: 70, cycle: 2, rate: 60 },
};

// ====== 5) รหัสยาคุมกำเนิด (แก้ตามจริงของหน่วยบริการได้) ======
var PILL_CODES   = ['03'];                       // ยาเม็ดคุม (R-den tab 28)
var INJECT_CODES = ['12', 'DEPO-M', 'DEPO-M1'];  // ยาฉีดคุม (Depogestin/MEDROXY)
var HERBAL_DRUGTYPE = '10';                      // หมวดยาสมุนไพร

// ====== 6) visit ที่ไม่นับ (ยกเลิกบริการ) — JHCIS ไม่นับ flagservice='99' ======
var EXCLUDE_FLAGSERVICE = ['99'];

// ============================================================================
// ฟังก์ชันกดส่งเอง — แก้วันที่ที่ต้องการตรงนี้
// ============================================================================
function sendManualReport() {
  try {
    var targetDate = '2026-06-11'; // YYYY-MM-DD
    var summary = fetchPPFSByDate(targetDate);
    pushToLine(buildPPFSFlexMessage(summary, targetDate));
    Logger.log('ส่งสำเร็จ! ' + targetDate + ' : รวม PPFS ' + summary.totalPpfs + ' บาท');
  } catch (err) {
    Logger.log('เกิดข้อผิดพลาด: ' + err);
    try { pushToLine({ type: 'text', text: '⚠️ รายงาน PPFS ส่งไม่สำเร็จ\n' + err }); }
    catch (e2) { Logger.log('แจ้ง error เข้า LINE ไม่สำเร็จ: ' + e2); }
  }
}

// ============================================================================
// Webhook: ตอบกลับเมื่อ user พิมพ์ "เช็คยอด 10/6/2025" (หรือ "เช็คยอดวันนี้")
// ----------------------------------------------------------------------------
// วิธี deploy: Apps Script → Deploy → New deployment → ชนิด "Web app"
//   Execute as: Me | Who has access: Anyone
// แล้วเอา URL ที่ได้ไปวางในช่อง Webhook URL ของ LINE Developers Console
// (Messaging API → Webhook settings → เปิด Use webhook)
// ============================================================================
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(function (ev) {
      if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
        handleText_(ev.replyToken, ev.message.text);
      }
    });
  } catch (err) {
    Logger.log('doPost error: ' + err);
  }
  return ContentService.createTextOutput('OK');
}

function handleText_(replyToken, text) {
  text = (text || '').trim();
  if (text.indexOf('เช็คยอด') !== 0) return; // ตอบเฉพาะคำสั่งนี้ (ไม่รบกวนแชตอื่น)

  var rest = text.substring('เช็คยอด'.length).trim();
  var iso;
  if (rest === '' || rest === 'วันนี้') {
    iso = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  } else {
    iso = parseThaiDate_(rest);
  }
  if (!iso) {
    replyToLine(replyToken, { type: 'text', text: 'พิมพ์ไม่ถูกรูปแบบครับ\nตัวอย่าง: เช็คยอด 10/6/2025  หรือ  เช็คยอดวันนี้' });
    return;
  }
  try {
    var summary = fetchPPFSByDate(iso);
    replyToLine(replyToken, buildPPFSFlexMessage(summary, iso));
  } catch (err) {
    replyToLine(replyToken, { type: 'text', text: '⚠️ ดึงข้อมูลวันที่ ' + iso + ' ไม่สำเร็จ\n' + err });
  }
}

// แปลงวันที่ที่ผู้ใช้พิมพ์ (d/m/yyyy, d-m-yyyy, d.m.yyyy) เป็น 'YYYY-MM-DD'
// รองรับปี พ.ศ. (>=2400 จะลบ 543) และปี 2 หลัก (+2000)
function parseThaiDate_(s) {
  var m = (s || '').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!m) return null;
  var day = parseInt(m[1], 10), mon = parseInt(m[2], 10), year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  if (year >= 2400) year -= 543; // พ.ศ. → ค.ศ.
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  var pad = function (x) { return (x < 10 ? '0' : '') + x; };
  return year + '-' + pad(mon) + '-' + pad(day);
}

// ============================================================================
// อ่านยอด PPFS ตามวันที่ระบุ ผ่าน JDBC
// ============================================================================
function fetchPPFSByDate(d) {
  var url = 'jdbc:mysql://' + DB.host + ':' + DB.port + '/' + DB.name;
  var conn = Jdbc.getConnection(url, DB.user, DB.pass);
  var inList = function (arr) { return arr.map(function (x) { return "'" + x + "'"; }).join(','); };
  var Q = "'" + d + "'";
  // เงื่อนไขตัด visit ที่ยกเลิก (ใช้ต่อท้าย WHERE) — alias ปรับได้
  var notCancelled = function (alias) { return ' AND ' + alias + '.flagservice NOT IN (' + inList(EXCLUDE_FLAGSERVICE) + ')'; };
  try {
    var st = conn.createStatement();
    var one = function (sql) {
      var rs = st.executeQuery(sql); var o = {}; var md = rs.getMetaData();
      if (rs.next()) for (var i = 1; i <= md.getColumnCount(); i++) o[md.getColumnLabel(i)] = rs.getInt(i);
      rs.close(); return o;
    };

    // ---- ยอดผู้รับบริการรวมวันนี้ (ไม่นับ visit ยกเลิก) ----
    var tot = one('SELECT COUNT(DISTINCT pid) total FROM visit v WHERE v.visitdate=' + Q + notCancelled('v'));

    // ---- รายการคัดกรอง (iron / hpv / fit) ----
    // ฐาน = "ทุกคนในช่วงอายุที่มาวันนี้" เพื่อเช็คความครบของงาน PP
    //   total   = มารับบริการในช่วงอายุนั้นวันนี้ (ทุกคน)
    //   covered = เคยได้รับบริการนี้แล้วภายในรอบ (ก่อนวันนี้) → ไม่ต้องทำซ้ำ
    //   due     = total - covered = ยังไม่ได้รับ (ต้องคัดกรอง)
    //   claim   = ได้รับบริการนี้วันนี้ + เป็นคน due → เคลม PPFS ได้
    var priorInCycle = function (code, years) {
      return 'EXISTS(SELECT 1 FROM visit v2 JOIN visitdiag d2 ON d2.pcucode=v2.pcucode AND d2.visitno=v2.visitno ' +
        "WHERE v2.pcucodeperson=v.pcucodeperson AND v2.pid=v.pid AND d2.diagcode='" + code + "' " +
        'AND v2.visitdate<' + Q + ' AND v2.visitdate>=DATE_SUB(' + Q + ', INTERVAL ' + years + ' YEAR)' + notCancelled('v2') + ')';
    };
    var bandAgg = function (cfg, k) {
      var t = 't' + k, r = 'r' + k, a = ' age BETWEEN ' + cfg.ageLo + ' AND ' + cfg.ageHi;
      return (
        '  COUNT(DISTINCT CASE WHEN' + a + ' THEN pid END) ' + k + '_total, ' +
        '  COUNT(DISTINCT CASE WHEN' + a + ' AND ' + r + ' THEN pid END) ' + k + '_covered, ' +
        '  COUNT(DISTINCT CASE WHEN' + a + ' AND ' + t + ' AND NOT ' + r + ' THEN pid END) ' + k + '_claim'
      );
    };
    var I = SCREEN.iron, H = SCREEN.hpv, F = SCREEN.fit;
    var sc = one(
      'SELECT ' + bandAgg(I, 'Iron') + ', ' + bandAgg(H, 'Hpv') + ', ' + bandAgg(F, 'Fit') + ' ' +
      'FROM ( SELECT v.pid pid, TIMESTAMPDIFF(YEAR, p.birth, ' + Q + ') age, ' +
      "    MAX(vd.diagcode='" + I.code + "') tIron, MAX(vd.diagcode='" + H.code + "') tHpv, MAX(vd.diagcode='" + F.code + "') tFit, " +
      '    ' + priorInCycle(I.code, I.cycle) + ' rIron, ' +
      '    ' + priorInCycle(H.code, H.cycle) + ' rHpv, ' +
      '    ' + priorInCycle(F.code, F.cycle) + ' rFit ' +
      '  FROM visit v JOIN person p ON p.pcucodeperson=v.pcucodeperson AND p.pid=v.pid ' +
      '  LEFT JOIN visitdiag vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno ' +
      '  WHERE v.visitdate=' + Q + notCancelled('v') + ' GROUP BY v.pid, v.pcucodeperson, age ) t'
    );

    // ---- รายการนับตรง (PRT, dT) ----
    var dg = one(
      'SELECT ' +
      "  COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z32.0','Z32.1') THEN v.pid END) prt, " +
      "  COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z23.5','Z23.6') THEN v.pid END) dt " +
      'FROM visit v JOIN visitdiag vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno WHERE v.visitdate=' + Q + notCancelled('v')
    );

    // ---- ยาคุม (เม็ด=นับแผง, ฉีด=นับคน) ----
    var ct = one(
      'SELECT ' +
      '  COALESCE(SUM(CASE WHEN vd.drugcode IN (' + inList(PILL_CODES) + ') THEN vd.unit END),0) pillPacks, ' +
      '  COUNT(DISTINCT CASE WHEN vd.drugcode IN (' + inList(INJECT_CODES) + ') THEN v.pid END) injPersons ' +
      'FROM visit v JOIN visitdrug vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno WHERE v.visitdate=' + Q + notCancelled('v')
    );

    // ---- สมุนไพร: นับคนที่ได้รับ (ยอดเงินรอประมวลผล) ----
    var hb = one(
      'SELECT COUNT(DISTINCT v.pid) herbalPersons FROM visit v ' +
      'JOIN visitdrug vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno ' +
      "JOIN cdrug cd ON cd.drugcode=vd.drugcode WHERE v.visitdate=" + Q + " AND cd.drugtype='" + HERBAL_DRUGTYPE + "'" + notCancelled('v')
    );

    // ---- EPI จาก visitepi (ยกเว้น COVID/dT, และ visit ที่ยกเลิก) ----
    var ep = one(
      'SELECT COUNT(*) epiDoses FROM visitepi e ' +
      'JOIN visit v ON v.pcucode=e.pcucode AND v.visitno=e.visitno ' +
      "WHERE e.dateepi=" + Q + " AND e.vaccinecode NOT LIKE 'COVID%' AND e.vaccinecode<>'dT'" + notCancelled('v')
    );
    st.close();

    var n = function (o, k) { return Number(o[k] || 0); };
    var screenItem = function (label, cfg, key) {
      var total = n(sc, key + '_total'), covered = n(sc, key + '_covered'), claim = n(sc, key + '_claim');
      return {
        type: 'screen', label: label,
        age: cfg.ageLo + '-' + cfg.ageHi + ' ปี', cycle: cfg.cycle,
        total: total, covered: covered, due: total - covered, claim: claim,
        amount: claim * cfg.rate,
      };
    };

    var items = [
      { type: 'plain', label: '1) ทดสอบการตั้งครรภ์ (PRT)', count: n(dg, 'prt'), unit: 'คน', amount: n(dg, 'prt') * PPFS.prt },
      screenItem('2) มะเร็งปากมดลูก (HPV)', SCREEN.hpv, 'Hpv'),
      screenItem('3) มะเร็งลำไส้ (Fit Test)', SCREEN.fit, 'Fit'),
      { type: 'plain', label: '4) จ่ายยาสมุนไพร', count: n(hb, 'herbalPersons'), unit: 'คน', amount: null, note: 'อยู่ระหว่างประมวลผล' },
      { type: 'pending', label: '5) OP anywhere', amount: null, note: 'อยู่ระหว่างประมวลผล' },
      screenItem('6) ยาเสริมธาตุเหล็ก', SCREEN.iron, 'Iron'),
      { type: 'plain', label: '7) ยาเม็ดคุมกำเนิด', count: n(ct, 'pillPacks'), unit: 'แผง', amount: n(ct, 'pillPacks') * PPFS.pill },
      { type: 'plain', label: '8) ยาฉีดคุมกำเนิด', count: n(ct, 'injPersons'), unit: 'คน', amount: n(ct, 'injPersons') * PPFS.inject },
      { type: 'plain', label: '9) วัคซีน EPI', count: n(ep, 'epiDoses'), unit: 'โดส', amount: n(ep, 'epiDoses') * PPFS.epi },
      { type: 'plain', label: '10) วัคซีน dT', count: n(dg, 'dt'), unit: 'คน', amount: n(dg, 'dt') * PPFS.dt },
    ];
    var totalPpfs = items.reduce(function (s, it) { return s + (it.amount || 0); }, 0);
    return { total: n(tot, 'total'), items: items, totalPpfs: totalPpfs };
  } finally {
    conn.close();
  }
}

// ============================================================================
// Flex Message
// ============================================================================
function buildPPFSFlexMessage(summary, d) {
  var parts = d.split('-');
  var displayDate = parts[2] + '/' + parts[1] + '/' + parts[0];

  var row = function (label, value, color, indent) {
    return {
      type: 'box', layout: 'horizontal', margin: 'xs',
      contents: [
        { type: 'text', text: (indent ? '   ' : '') + label, size: 'xs', color: indent ? '#999999' : '#777777', flex: 6, wrap: true },
        { type: 'text', text: value, size: 'xs', align: 'end', weight: 'bold', color: color || '#111111', flex: 4, wrap: true },
      ],
    };
  };

  var body = [];
  // กล่องยอดผู้รับบริการรวมวันนี้ (ด้านบนสุด)
  body.push({
    type: 'box', layout: 'horizontal', backgroundColor: '#f0f8ff', paddingAll: 'md', cornerRadius: 'md',
    contents: [
      { type: 'text', text: '👥 ผู้รับบริการรวม', size: 'sm', weight: 'bold', color: '#0D2C54' },
      { type: 'text', text: summary.total + ' คน', size: 'md', align: 'end', weight: 'bold', color: '#0D2C54' },
    ],
  });
  body.push({ type: 'separator', margin: 'lg' });

  summary.items.forEach(function (it) {
    var amountText = (it.amount === null) ? (it.note || '-') : (fmtBaht_(it.amount) + ' ฿');
    var amountColor = (it.amount === null) ? '#e0a800' : '#03c75a';
    var lines = [{ type: 'text', text: it.label, size: 'sm', weight: 'bold', color: '#333333', wrap: true }];

    if (it.type === 'screen') {
      var complete = (it.due === it.claim) ? '  ✅' : '  ⚠️ขาด ' + (it.due - it.claim);
      lines.push({ type: 'text', text: 'อายุ ' + it.age + ' · รอบ ' + it.cycle + ' ปี', size: 'xxs', color: '#aaaaaa' });
      lines.push(row('มารับบริการ (ช่วงอายุ)', it.total + ' คน'));
      lines.push(row('• เคยได้รับในรอบ', it.covered + ' คน', '#777777', true));
      lines.push(row('• ยังไม่ได้รับ (ต้องคัดกรอง)', it.due + ' คน', '#c0392b', true));
      lines.push(row('• คัดกรองแล้ววันนี้', it.claim + ' คน' + complete, '#1f6fb2', true));
      lines.push(row('ยอดจ่าย PPFS', amountText, amountColor));
    } else if (it.type === 'pending') {
      lines.push(row('สถานะ', amountText, amountColor));
    } else {
      lines.push(row('ทำได้ ' + it.count + ' ' + it.unit, amountText, amountColor));
    }

    body.push({ type: 'box', layout: 'vertical', margin: 'md', contents: lines });
    body.push({ type: 'separator', margin: 'md' });
  });
  if (body.length) body.pop();

  return {
    type: 'flex',
    altText: '💰 ยอด PPFS ' + displayDate + ' = ' + fmtBaht_(summary.totalPpfs) + ' บาท',
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0D2C54',
        contents: [
          { type: 'text', text: '💰 ยอด PPFS ที่จ่ายได้วันนี้', color: '#ffffff', weight: 'bold', size: 'md' },
          { type: 'text', text: 'ประจำวันที่ ' + displayDate, color: '#ffffffcc', size: 'xs', margin: 'sm' },
        ],
      },
      body: { type: 'box', layout: 'vertical', contents: body },
      footer: {
        type: 'box', layout: 'horizontal', backgroundColor: '#fff4f4', paddingAll: 'lg',
        contents: [
          { type: 'text', text: '💰 รวมยอด PPFS', size: 'sm', weight: 'bold', color: '#d9534f' },
          { type: 'text', text: fmtBaht_(summary.totalPpfs) + ' ฿', size: 'md', align: 'end', weight: 'bold', color: '#d9534f' },
        ],
      },
    },
  };
}

function fmtBaht_(n) {
  return Number(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ============================================================================
// ส่งเข้า LINE
// ============================================================================
function pushToLine(payload) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + LINE_TOKEN },
    muteHttpExceptions: true,
    payload: JSON.stringify({ to: LINE_TARGET_ID, messages: [payload] }),
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('LINE API ตอบกลับ ' + code + ': ' + res.getContentText());
}

// ตอบกลับข้อความที่ user พิมพ์ (ใช้ replyToken จาก webhook — ฟรี/ตอบทันที)
function replyToLine(replyToken, payload) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + LINE_TOKEN },
    muteHttpExceptions: true,
    payload: JSON.stringify({ replyToken: replyToken, messages: [payload] }),
  });
  if (res.getResponseCode() !== 200) Logger.log('reply error ' + res.getResponseCode() + ': ' + res.getContentText());
}
