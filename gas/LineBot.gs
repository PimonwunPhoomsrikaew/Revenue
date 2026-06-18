/**
 * LINE Bot รวม 2 ระบบในโปรเจกต์เดียว (doPost เดียว route ตามข้อความ)
 *   • พิมพ์ขึ้นต้นด้วย "เช็คยอด ..." → รายงาน PPFS รายวัน (ต่อ MySQL JHCIS ผ่าน JDBC)
 *       - "เช็คยอด 10/6/2025"  หรือ  "เช็คยอดวันนี้"
 *   • พิมพ์อย่างอื่น           → ค้นสต๊อกสินค้าจาก Google Sheet (เหมือนเดิม)
 *
 * รองรับกลุ่ม/ห้อง/แชทส่วนตัว + Loading animation + Flex/Carousel
 * Deploy เป็น Web App แล้ววาง URL ใน LINE Webhook (เปิด Use webhook, ปิด Auto-reply)
 * ============================================================================
 */

// ==========================================
// 1. ตั้งค่าระบบ
// ==========================================
// ⚠️ ใส่ Channel access token ของคุณ (อย่าแชร์ต่อ/อย่า commit ขึ้นที่สาธารณะ)
var LINE_ACCESS_TOKEN = 'ใส่_CHANNEL_ACCESS_TOKEN_ที่นี่';

// ---- ค้นสต๊อก (Google Sheet) ----
var SHEET_ID = '1sP5oC8fGpeccr1SYK03NIMsK5nKpJRqhWpfzajTqrFA';
var SHEET_NAME = 'รายการสินค้า';
var CACHE_KEY = 'stock_inverted_index';
var CACHE_TIME = 300; // 5 นาที

// ---- รายงาน PPFS (MySQL JHCIS) ----
var DB = { host: '183.88.232.251', port: 3333, name: 'jhcisdb01088', user: 'db01088', pass: '@jhcis01088*' };
var PPFS = { prt: 75, hpv: 50, fit: 60, iron: 80, pill: 40, inject: 60, epi: 20, dt: 20 };
var SCREEN = {
  // sex: '2'=เฉพาะหญิง, ไม่ระบุ=ทุกเพศ  (person.sex 1=ชาย, 2=หญิง)
  iron: { code: 'Z13.0', ageLo: 13, ageHi: 45, cycle: 1, rate: 80, sex: '2' },
  hpv:  { code: 'Z12.4', ageLo: 30, ageHi: 59, cycle: 5, rate: 50, sex: '2' },
  fit:  { code: 'Z12.1', ageLo: 50, ageHi: 70, cycle: 2, rate: 60 },
};
var PILL_CODES = ['03'];
var INJECT_CODES = ['12', 'DEPO-M', 'DEPO-M1'];
var HERBAL_NAME = 'ไพล'; // สมุนไพร: จับจากยาที่ชื่อมีคำนี้ (จ่ายตามจริง = SUM realprice)
var EXCLUDE_FLAGSERVICE = ['99']; // visit ที่ยกเลิก — ไม่นับ

// ==========================================
// 2. Webhook — route ตามข้อความ
// ==========================================
function doPost(e) {
  try {
    // กันกรณีถูกเรียกโดยไม่มีข้อมูล (กด Run ใน editor, request GET, หรือ verify webhook)
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput('OK');
    }
    Logger.log('▶️ doPost (LineBot รวม สต๊อก+PPFS+PP) ทำงาน'); // ตัวบ่งชี้ว่าโค้ดใหม่ทำงาน
    var data = JSON.parse(e.postData.contents);
    var event = (data.events || [])[0];
    if (!event) return ContentService.createTextOutput('OK');

    if (event.type === 'message' && event.message.type === 'text') {
      var userMessage = (event.message.text || '').trim();
      var replyToken = event.replyToken;
      var chatId = (event.source.type === 'group') ? event.source.groupId
                 : (event.source.type === 'room') ? event.source.roomId
                 : event.source.userId;

      // เลือกโหมดตามคำขึ้นต้น (ทุกโหมดต้องพิมพ์คำสั่งนำหน้า)
      var handler = null;
      if (userMessage.indexOf('เช็คยอด') === 0) {
        handler = function () { return handlePPFSCommand_(userMessage); };       // รายงาน PPFS รายวัน
      } else if (/^เช็ค\s*pp/i.test(userMessage)) {
        handler = function () { return handlePPCheck_(userMessage); };           // ตรวจสิทธิ PP รายคน
      } else if (userMessage.indexOf('ค้นหา') === 0) {
        handler = function () {
          var q = userMessage.substring('ค้นหา'.length).trim();                  // ค้นสต๊อก (ตัดคำว่า "ค้นหา")
          return q ? searchInvertedIndex(q, getOrBuildDatabase())
                   : { type: 'text', text: 'พิมพ์ชื่อสินค้าต่อท้ายด้วยครับ เช่น "ค้นหา พารา"' };
        };
      } else if (event.source.type === 'user') {
        handler = function () { return helpMessage_(); };                        // แนะนำคำสั่ง (เฉพาะแชตส่วนตัว)
      }

      // ตอบเฉพาะข้อความที่ตรงคำสั่ง — ในกลุ่ม/ห้อง ข้อความอื่นจะเงียบ ไม่รบกวน
      if (handler) {
        Logger.log('📩 รับข้อความ: "' + userMessage + '" (source=' + event.source.type + ')');
        if (chatId) startLoadingAnimation(chatId);
        replyToLine(replyToken, handler());
      }
    }
    return ContentService.createTextOutput('OK');
  } catch (error) {
    console.error('Error:', error);
    return ContentService.createTextOutput('Error');
  }
}

// ==========================================
// 3. คำสั่ง "เช็คยอด <วันที่>" → รายงาน PPFS
// ==========================================
function handlePPFSCommand_(text) {
  var rest = text.substring('เช็คยอด'.length).trim();
  var iso = (rest === '' || rest === 'วันนี้')
    ? Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd')
    : parseThaiDate_(rest);
  if (!iso) {
    return { type: 'text', text: 'พิมพ์ไม่ถูกรูปแบบครับ\nตัวอย่าง: เช็คยอด 10/6/2025  หรือ  เช็คยอดวันนี้' };
  }
  try {
    var summary = fetchPPFSByDate(iso);
    return buildPPFSFlexMessage(summary, iso);
  } catch (err) {
    return { type: 'text', text: '⚠️ ดึงข้อมูลวันที่ ' + iso + ' ไม่สำเร็จ\n' + err };
  }
}

// ---- ฟังก์ชันทดสอบ (กด Run ได้เลยใน editor — ไม่ต้องผ่าน LINE) ----
// ดูผลที่เมนู View → Logs (Executions)
function testPPFS() {
  var iso = parseThaiDate_('11/6/2026');           // เปลี่ยนวันที่ทดสอบได้
  var summary = fetchPPFSByDate(iso);
  Logger.log('วันที่ ' + iso + ' | ผู้รับบริการรวม ' + summary.total + ' คน | รวม PPFS ' + summary.totalPpfs + ' บาท');
  summary.items.forEach(function (it) {
    Logger.log(it.label + ' → ' + (it.amount === null ? it.note : it.amount + ' บาท'));
  });
}

// จำลอง webhook event เพื่อทดสอบ doPost ทั้งเส้น (แต่จะส่งเข้า LINE จริงด้วย replyToken ปลอมไม่ได้)
function testParse() {
  ['เช็คยอด 10/6/2025', 'เช็คยอดวันนี้', 'เช็คยอด 1/1/2569', 'พารา'].forEach(function (t) {
    Logger.log(t + ' → ' + (t.indexOf('เช็คยอด') === 0 ? 'PPFS' : 'ค้นสต๊อก'));
  });
}

// ข้อความแนะนำคำสั่ง
function helpMessage_() {
  return { type: 'text', text:
    '🤖 พิมพ์คำสั่งได้ดังนี้\n' +
    '• เช็คยอด 10/6/2025 — รายงานยอด PPFS รายวัน\n' +
    '• เช็ค PP 1234567890123 — ตรวจสิทธิคัดกรองรายคน\n' +
    '• ค้นหา พารา — ค้นสต๊อกสินค้า' };
}

// ==========================================
// 3b. คำสั่ง "เช็ค PP <เลขบัตร>" → ตรวจสิทธิคัดกรองรายคน
// ==========================================
function handlePPCheck_(text) {
  var m = text.match(/(\d{13})/); // ดึงเลขบัตร 13 หลัก
  if (!m) {
    return { type: 'text', text: 'พิมพ์เลขบัตรประชาชน 13 หลักด้วยครับ\nตัวอย่าง: เช็ค PP 1234567890123' };
  }
  try {
    return buildPPCheckFlex_(fetchPPPerson_(m[1]), m[1]);
  } catch (err) {
    return { type: 'text', text: '⚠️ ตรวจสอบไม่สำเร็จ\n' + err };
  }
}

// ค้นคนจากเลขบัตร + สิทธิคัดกรองตามอายุ + ประวัติเคย/ไม่เคยในรอบ
function fetchPPPerson_(cid) {
  var url = 'jdbc:mysql://' + DB.host + ':' + DB.port + '/' + DB.name;
  var conn = Jdbc.getConnection(url, DB.user, DB.pass);
  try {
    var st = conn.createStatement();
    var rs = st.executeQuery(
      'SELECT p.pcucodeperson pc, p.pid, p.sex, pn.prename pretext, p.fname, p.lname, ' +
      ' TIMESTAMPDIFF(YEAR, p.birth, CURDATE()) age ' +
      'FROM person p LEFT JOIN _tmpprename_code pn ON pn.prenamecode=p.prename ' +
      "WHERE p.idcard='" + cid + "' LIMIT 1"
    );
    if (!rs.next()) { rs.close(); st.close(); return { found: false }; }
    var pc = rs.getString('pc'), pid = rs.getInt('pid');
    var sex = rs.getString('sex');
    var name = ((rs.getString('pretext') || '') + (rs.getString('fname') || '') + ' ' + (rs.getString('lname') || '')).trim();
    var age = rs.getInt('age');
    rs.close();

    var h = st.executeQuery(
      'SELECT ' +
      "  MAX(CASE WHEN vd.diagcode='Z13.0' THEN v.visitdate END) iron_last, " +
      "  MAX(CASE WHEN vd.diagcode='Z13.0' AND v.visitdate>=DATE_SUB(CURDATE(),INTERVAL " + SCREEN.iron.cycle + " YEAR) THEN 1 ELSE 0 END) iron_in, " +
      "  MAX(CASE WHEN vd.diagcode='Z12.4' THEN v.visitdate END) hpv_last, " +
      "  MAX(CASE WHEN vd.diagcode='Z12.4' AND v.visitdate>=DATE_SUB(CURDATE(),INTERVAL " + SCREEN.hpv.cycle + " YEAR) THEN 1 ELSE 0 END) hpv_in, " +
      "  MAX(CASE WHEN vd.diagcode='Z12.1' THEN v.visitdate END) fit_last, " +
      "  MAX(CASE WHEN vd.diagcode='Z12.1' AND v.visitdate>=DATE_SUB(CURDATE(),INTERVAL " + SCREEN.fit.cycle + " YEAR) THEN 1 ELSE 0 END) fit_in " +
      'FROM visit v JOIN visitdiag vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno ' +
      "WHERE v.pcucodeperson='" + pc + "' AND v.pid=" + pid + " AND v.flagservice NOT IN ('99') " +
      "AND vd.diagcode IN ('Z13.0','Z12.4','Z12.1')"
    );
    var hist = {};
    if (h.next()) ['iron_last','iron_in','hpv_last','hpv_in','fit_last','fit_in'].forEach(function (k) { hist[k] = h.getString(k); });
    h.close(); st.close();

    var services = [];
    var sexExcluded = false; // true = อายุเข้าช่วง แต่ถูกตัดเพราะเพศ (เช่น ชายที่เข้าช่วง HPV/ธาตุเหล็ก)
    var add = function (key, label, lastKey, inKey) {
      var cfg = SCREEN[key];
      var inAge = (age >= cfg.ageLo && age <= cfg.ageHi);
      if (cfg.sex && cfg.sex !== sex) { if (inAge) sexExcluded = true; return; } // จำกัดเพศ
      if (inAge) {
        services.push({ label: label, cycle: cfg.cycle, inCycle: (hist[inKey] === '1'), last: hist[lastKey] || null });
      }
    };
    add('iron', 'ยาเสริมธาตุเหล็ก', 'iron_last', 'iron_in');
    add('hpv', 'HPV (มะเร็งปากมดลูก)', 'hpv_last', 'hpv_in');
    add('fit', 'Fit Test (มะเร็งลำไส้)', 'fit_last', 'fit_in');
    return { found: true, name: name, age: age, sex: sex, services: services, sexExcluded: sexExcluded };
  } finally {
    conn.close();
  }
}

function buildPPCheckFlex_(info, cid) {
  if (!info.found) return { type: 'text', text: '❌ ไม่พบคนไข้ที่มีเลขบัตร ' + cid };
  var d2t = function (s) { if (!s) return '-'; var p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; };

  var body = [
    { type: 'text', text: '👤 ' + info.name, size: 'md', weight: 'bold', color: '#0D2C54', wrap: true },
    { type: 'text', text: 'อายุ ' + info.age + ' ปี', size: 'sm', color: '#555555' },
    { type: 'separator', margin: 'md' },
  ];

  if (info.services.length === 0) {
    var emptyMsg = info.sexExcluded
      ? '❌ ไม่สามารถจ่าย PP — รายการในช่วงอายุนี้ (HPV / ยาเสริมธาตุเหล็ก) เป็นบริการเฉพาะหญิง'
      : 'อายุนี้ยังไม่อยู่ในช่วงรายการคัดกรอง PP (13-70 ปี)';
    body.push({ type: 'text', text: emptyMsg, size: 'sm', color: '#999999', margin: 'md', wrap: true });
  } else {
    body.push({ type: 'text', text: 'มีสิทธิได้รับ ' + info.services.length + ' รายการ:', size: 'sm', weight: 'bold', color: '#333333', margin: 'md' });
    info.services.forEach(function (s) {
      var statusText, statusColor;
      if (s.inCycle) {
        statusText = '⛔ เคยได้รับแล้ว (ล่าสุด ' + d2t(s.last) + ') ยังไม่ถึงรอบ ' + s.cycle + ' ปี';
        statusColor = '#c0392b';
      } else {
        statusText = '✅ มีสิทธิรับได้' + (s.last ? ' (เคยรับ ' + d2t(s.last) + ' เกินรอบแล้ว)' : ' (ยังไม่เคยรับ)');
        statusColor = '#03c75a';
      }
      body.push({
        type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
        contents: [
          { type: 'text', text: '• ' + s.label, size: 'sm', weight: 'bold', color: '#1f6fb2', wrap: true },
          { type: 'text', text: '   ' + statusText, size: 'xs', color: statusColor, wrap: true },
        ],
      });
    });
  }

  // สิทธิเพศชาย: ถุงยางอนามัย 10 ชิ้น/สัปดาห์ (อายุ 13 ปีขึ้นไป)
  if (info.sex === '1' && info.age >= 13) {
    body.push({ type: 'separator', margin: 'md' });
    body.push({
      type: 'box', layout: 'vertical', backgroundColor: '#eafaf1', cornerRadius: 'md', paddingAll: 'md', margin: 'md', spacing: 'xs',
      contents: [
        { type: 'text', text: '🧤 สิทธิเพศชาย: ถุงยางอนามัย', size: 'sm', weight: 'bold', color: '#16794c' },
        { type: 'text', text: 'จ่ายได้ 10 ชิ้น/สัปดาห์', size: 'xs', color: '#16794c' },
      ],
    });
  }

  return {
    type: 'flex',
    altText: 'ตรวจสิทธิ PP: ' + info.name + ' อายุ ' + info.age + ' ปี',
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0D2C54',
        contents: [{ type: 'text', text: '🩺 ตรวจสอบสิทธิคัดกรอง PP', color: '#ffffff', weight: 'bold', size: 'md' }],
      },
      body: { type: 'box', layout: 'vertical', contents: body },
    },
  };
}

// แปลงวันที่ (d/m/yyyy, d-m-yyyy, d.m.yyyy) → 'YYYY-MM-DD' (รองรับ พ.ศ. และปี 2 หลัก)
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

// ==========================================
// 4. ดึงยอด PPFS ตามวันที่ ผ่าน JDBC (MySQL JHCIS)
// ==========================================
function fetchPPFSByDate(d) {
  // ใส่ charset UTF-8 เพื่อให้ค้นชื่อยาภาษาไทย (เช่น "ไพล") ใน SQL ได้ถูกต้อง
  var url = 'jdbc:mysql://' + DB.host + ':' + DB.port + '/' + DB.name + '?useUnicode=true&characterEncoding=UTF-8';
  var conn = Jdbc.getConnection(url, DB.user, DB.pass);
  var inList = function (arr) { return arr.map(function (x) { return "'" + x + "'"; }).join(','); };
  var Q = "'" + d + "'";
  var notCancelled = function (alias) { return ' AND ' + alias + '.flagservice NOT IN (' + inList(EXCLUDE_FLAGSERVICE) + ')'; };
  try {
    var st = conn.createStatement();
    var one = function (sql) {
      var rs = st.executeQuery(sql); var o = {}; var md = rs.getMetaData();
      if (rs.next()) for (var i = 1; i <= md.getColumnCount(); i++) o[md.getColumnLabel(i)] = rs.getInt(i);
      rs.close(); return o;
    };

    var tot = one('SELECT COUNT(DISTINCT pid) total FROM visit v WHERE v.visitdate=' + Q + notCancelled('v'));

    var priorInCycle = function (code, years) {
      return 'EXISTS(SELECT 1 FROM visit v2 JOIN visitdiag d2 ON d2.pcucode=v2.pcucode AND d2.visitno=v2.visitno ' +
        "WHERE v2.pcucodeperson=v.pcucodeperson AND v2.pid=v.pid AND d2.diagcode='" + code + "' " +
        'AND v2.visitdate<' + Q + ' AND v2.visitdate>=DATE_SUB(' + Q + ', INTERVAL ' + years + ' YEAR)' + notCancelled('v2') + ')';
    };
    // ฐาน total/covered/due = ทุกเพศ (เพื่อให้เห็น ช/ญ) แต่ claim (PPFS) จำกัดเพศตาม cfg.sex
    var bandAgg = function (cfg, k) {
      var t = 't' + k, r = 'r' + k;
      var a = 'age BETWEEN ' + cfg.ageLo + ' AND ' + cfg.ageHi;
      var claimSex = cfg.sex ? " AND sex='" + cfg.sex + "'" : '';
      return (
        '  COUNT(DISTINCT CASE WHEN ' + a + ' THEN pid END) ' + k + '_total, ' +
        '  COUNT(DISTINCT CASE WHEN ' + a + ' AND ' + r + ' THEN pid END) ' + k + '_covered, ' +
        "  COUNT(DISTINCT CASE WHEN " + a + " AND NOT " + r + " AND sex='1' THEN pid END) " + k + '_duem, ' +
        "  COUNT(DISTINCT CASE WHEN " + a + " AND NOT " + r + " AND sex='2' THEN pid END) " + k + '_duef, ' +
        '  COUNT(DISTINCT CASE WHEN ' + a + ' AND ' + t + ' AND NOT ' + r + claimSex + ' THEN pid END) ' + k + '_claim'
      );
    };
    var I = SCREEN.iron, H = SCREEN.hpv, F = SCREEN.fit;
    var sc = one(
      'SELECT ' + bandAgg(I, 'Iron') + ', ' + bandAgg(H, 'Hpv') + ', ' + bandAgg(F, 'Fit') + ' ' +
      'FROM ( SELECT v.pid pid, p.sex sex, TIMESTAMPDIFF(YEAR, p.birth, ' + Q + ') age, ' +
      "    MAX(vd.diagcode='" + I.code + "') tIron, MAX(vd.diagcode='" + H.code + "') tHpv, MAX(vd.diagcode='" + F.code + "') tFit, " +
      '    ' + priorInCycle(I.code, I.cycle) + ' rIron, ' +
      '    ' + priorInCycle(H.code, H.cycle) + ' rHpv, ' +
      '    ' + priorInCycle(F.code, F.cycle) + ' rFit ' +
      '  FROM visit v JOIN person p ON p.pcucodeperson=v.pcucodeperson AND p.pid=v.pid ' +
      '  LEFT JOIN visitdiag vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno ' +
      '  WHERE v.visitdate=' + Q + notCancelled('v') + ' GROUP BY v.pid, v.pcucodeperson, p.sex, age ) t'
    );

    var dg = one(
      'SELECT ' +
      "  COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z32.0','Z32.1') THEN v.pid END) prt, " +
      "  COUNT(DISTINCT CASE WHEN vd.diagcode IN ('Z23.5','Z23.6') THEN v.pid END) dt " +
      'FROM visit v JOIN visitdiag vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno WHERE v.visitdate=' + Q + notCancelled('v')
    );

    var ct = one(
      'SELECT ' +
      '  COALESCE(SUM(CASE WHEN vd.drugcode IN (' + inList(PILL_CODES) + ') THEN vd.unit END),0) pillPacks, ' +
      '  COUNT(DISTINCT CASE WHEN vd.drugcode IN (' + inList(INJECT_CODES) + ') THEN v.pid END) injPersons ' +
      'FROM visit v JOIN visitdrug vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno WHERE v.visitdate=' + Q + notCancelled('v')
    );

    // สมุนไพร: จับจากยาที่ชื่อมีคำว่า "ไพล" — นับคน + รวมมูลค่าที่จ่ายจริง (realprice)
    var herbal = { persons: 0, value: 0 };
    var rsh = st.executeQuery(
      'SELECT COUNT(DISTINCT v.pid) persons, COALESCE(SUM(vd.realprice),0) val ' +
      'FROM visit v JOIN visitdrug vd ON vd.pcucode=v.pcucode AND vd.visitno=v.visitno ' +
      'JOIN cdrug cd ON cd.drugcode=vd.drugcode ' +
      'WHERE v.visitdate=' + Q + notCancelled('v') +
      " AND (cd.drugnamethai LIKE '%" + HERBAL_NAME + "%' OR cd.drugname LIKE '%" + HERBAL_NAME + "%')"
    );
    if (rsh.next()) { herbal.persons = rsh.getInt('persons'); herbal.value = Number(rsh.getString('val')); }
    rsh.close();

    var ep = one(
      'SELECT COUNT(*) epiDoses FROM visitepi e ' +
      'JOIN visit v ON v.pcucode=e.pcucode AND v.visitno=e.visitno ' +
      "WHERE e.dateepi=" + Q + " AND e.vaccinecode NOT LIKE 'COVID%' AND e.vaccinecode<>'dT'" + notCancelled('v')
    );
    st.close();

    var n = function (o, k) { return Number(o[k] || 0); };
    var screenItem = function (label, cfg, key) {
      var total = n(sc, key + '_total'), covered = n(sc, key + '_covered'), claim = n(sc, key + '_claim');
      var duem = n(sc, key + '_duem'), duef = n(sc, key + '_duef'), due = total - covered;
      return {
        type: 'screen', label: label, age: cfg.ageLo + '-' + cfg.ageHi + ' ปี', cycle: cfg.cycle,
        total: total, covered: covered, due: due, claim: claim, amount: claim * cfg.rate,
        bySex: !!cfg.sex,        // true = แสดง ยังไม่ได้รับ (ช/ญ)
        duem: duem, duef: duef,
        dueTarget: cfg.sex ? duef : due,   // เป้าที่ต้องคัดกรอง (เพศที่จ่ายได้)
      };
    };

    var items = [
      { type: 'plain', label: '1) ทดสอบการตั้งครรภ์ (PRT)', count: n(dg, 'prt'), unit: 'คน', amount: n(dg, 'prt') * PPFS.prt },
      screenItem('2) มะเร็งปากมดลูก (HPV)', SCREEN.hpv, 'Hpv'),
      screenItem('3) มะเร็งลำไส้ (Fit Test)', SCREEN.fit, 'Fit'),
      { type: 'plain', label: '4) จ่ายยาสมุนไพร (ไพล)', count: herbal.persons, unit: 'คน', amount: herbal.value },
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

function buildPPFSFlexMessage(summary, d) {
  var parts = d.split('-');
  var displayDate = parts[2] + '/' + parts[1] + '/' + parts[0];
  var row = function (label, value, color, indent) {
    return { type: 'box', layout: 'horizontal', margin: 'xs', contents: [
      { type: 'text', text: (indent ? '   ' : '') + label, size: 'xs', color: indent ? '#999999' : '#777777', flex: 6, wrap: true },
      { type: 'text', text: value, size: 'xs', align: 'end', weight: 'bold', color: color || '#111111', flex: 4, wrap: true },
    ] };
  };
  var body = [];
  body.push({ type: 'box', layout: 'horizontal', backgroundColor: '#f0f8ff', paddingAll: 'md', cornerRadius: 'md', contents: [
    { type: 'text', text: '👥 ผู้รับบริการรวม', size: 'sm', weight: 'bold', color: '#0D2C54' },
    { type: 'text', text: summary.total + ' คน', size: 'md', align: 'end', weight: 'bold', color: '#0D2C54' },
  ] });
  body.push({ type: 'separator', margin: 'lg' });

  summary.items.forEach(function (it) {
    var amountText = (it.amount === null) ? (it.note || '-') : (fmtBaht_(it.amount) + ' ฿');
    var amountColor = (it.amount === null) ? '#e0a800' : '#03c75a';
    var lines = [{ type: 'text', text: it.label, size: 'sm', weight: 'bold', color: '#333333', wrap: true }];
    if (it.type === 'screen') {
      var complete = (it.dueTarget === it.claim) ? '  ✅' : '  ⚠️ขาด ' + (it.dueTarget - it.claim);
      lines.push({ type: 'text', text: 'อายุ ' + it.age + ' · รอบ ' + it.cycle + ' ปี', size: 'xxs', color: '#aaaaaa' });
      lines.push(row('มารับบริการ (ช่วงอายุ)', it.total + ' คน'));
      lines.push(row('• เคยได้รับในรอบ', it.covered + ' คน', '#777777', true));
      if (it.bySex) {
        lines.push(row('• ยังไม่ได้รับ (ช/ญ)', it.duem + '/' + it.duef + ' คน', '#c0392b', true));
      } else {
        lines.push(row('• ยังไม่ได้รับ (ต้องคัดกรอง)', it.due + ' คน', '#c0392b', true));
      }
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
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0D2C54', contents: [
        { type: 'text', text: '💰 ยอด PPFS ที่จ่ายได้', color: '#ffffff', weight: 'bold', size: 'md' },
        { type: 'text', text: 'ประจำวันที่ ' + displayDate, color: '#ffffffcc', size: 'xs', margin: 'sm' },
      ] },
      body: { type: 'box', layout: 'vertical', contents: body },
      footer: { type: 'box', layout: 'horizontal', backgroundColor: '#fff4f4', paddingAll: 'lg', contents: [
        { type: 'text', text: '💰 รวมยอด PPFS', size: 'sm', weight: 'bold', color: '#d9534f' },
        { type: 'text', text: fmtBaht_(summary.totalPpfs) + ' ฿', size: 'md', align: 'end', weight: 'bold', color: '#d9534f' },
      ] },
    },
  };
}

function fmtBaht_(n) {
  // จำนวนเต็มแสดงเลขเต็ม, ถ้ามีเศษสตางค์แสดง 2 ตำแหน่ง + คั่นหลักพัน
  var x = Math.round((Number(n) || 0) * 100) / 100;
  var s = (x % 1 === 0) ? String(x) : x.toFixed(2);
  var parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

// ==========================================
// 5. ค้นสต๊อกสินค้า (Inverted Index + Cache Chunking)
// ==========================================
function getOrBuildDatabase() {
  var cache = CacheService.getScriptCache();
  var totalChunks = cache.get(CACHE_KEY + '_total');
  if (totalChunks) {
    var fullJsonString = '', isCacheValid = true;
    for (var i = 0; i < parseInt(totalChunks); i++) {
      var chunk = cache.get(CACHE_KEY + '_chunk_' + i);
      if (!chunk) { isCacheValid = false; break; }
      fullJsonString += chunk;
    }
    if (isCacheValid) return JSON.parse(fullJsonString);
  }

  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var data = sheet.getDataRange().getDisplayValues();
  var db = { index: {}, items: {} };
  for (var r = 1; r < data.length; r++) {
    var itemName = data[r][0], itemQty = data[r][1];
    if (!itemName) continue;
    db.items[r] = { name: itemName, qty: itemQty };
    var tokens = itemName.toLowerCase().split(/\s+/);
    tokens.forEach(function (token) {
      if (!token) return;
      if (!db.index[token]) db.index[token] = [];
      if (db.index[token].indexOf(r) === -1) db.index[token].push(r);
    });
  }

  var jsonString = JSON.stringify(db);
  var chunkSize = 90000;
  var chunksCount = Math.ceil(jsonString.length / chunkSize);
  cache.put(CACHE_KEY + '_total', chunksCount.toString(), CACHE_TIME);
  for (var c = 0; c < chunksCount; c++) {
    cache.put(CACHE_KEY + '_chunk_' + c, jsonString.substring(c * chunkSize, (c + 1) * chunkSize), CACHE_TIME);
  }
  return db;
}

function searchInvertedIndex(query, db) {
  var queryTokens = (query || '').toLowerCase().split(/\s+/);
  if (queryTokens.length === 0) return { type: 'text', text: 'กรุณาพิมพ์ชื่อสินค้าที่ต้องการค้นหาครับ' };

  var matchScores = {};
  queryTokens.forEach(function (token) {
    if (!token) return;
    Object.keys(db.index).forEach(function (indexWord) {
      if (indexWord.indexOf(token) !== -1) {
        db.index[indexWord].forEach(function (rowId) { matchScores[rowId] = (matchScores[rowId] || 0) + 1; });
      }
    });
  });

  var foundItems = [];
  for (var rowId in matchScores) {
    if (matchScores[rowId] > 0) foundItems.push(db.items[rowId]);
  }

  if (foundItems.length > 0) {
    return buildStockFlexMessage(query, foundItems.slice(0, 100));
  }
  return { type: 'text', text: '❌ ไม่พบสินค้า โปรดระบุคีย์เวิร์ดใหม่อีกครั้งครับ' };
}

function buildStockFlexMessage(keyword, itemArray) {
  var BUBBLE_MAX_ITEMS = 10;
  var bubbles = [];
  for (var i = 0; i < itemArray.length; i += BUBBLE_MAX_ITEMS) {
    var chunk = itemArray.slice(i, i + BUBBLE_MAX_ITEMS);
    var flexContents = [];
    chunk.forEach(function (item) {
      var qty = parseInt(item.qty);
      var qtyColor = '#03c75a';
      if (qty === 0) qtyColor = '#ff334b';
      else if (qty <= 10) qtyColor = '#ff9900';
      flexContents.push({ type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: item.name, size: 'sm', color: '#555555', flex: 2, wrap: true },
        { type: 'text', text: item.qty + ' ชิ้น', size: 'sm', color: qtyColor, align: 'end', weight: 'bold', flex: 1 },
      ] });
      flexContents.push({ type: 'separator', margin: 'md' });
    });
    if (flexContents.length > 0) flexContents.pop();

    var pageNum = (i / BUBBLE_MAX_ITEMS) + 1;
    var totalPages = Math.ceil(itemArray.length / BUBBLE_MAX_ITEMS);
    bubbles.push({
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0D2C54', contents: [
        { type: 'text', text: '📦 รายงานผลสต๊อก', color: '#ffffff', weight: 'bold', size: 'md' },
        { type: 'text', text: 'ค้นหา: "' + keyword + '" (หน้า ' + pageNum + '/' + totalPages + ')', color: '#ffffffcc', size: 'xs', margin: 'sm' },
      ] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: flexContents },
    });
  }
  return {
    type: 'flex',
    altText: 'ผลการค้นหา: ' + keyword + ' (พบ ' + itemArray.length + ' รายการ)',
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ==========================================
// 6. ส่งข้อความ / Loading / เมนู
// ==========================================
function replyToLine(replyToken, messagePayload) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: Array.isArray(messagePayload) ? messagePayload : [messagePayload],
    }),
  });
  // log ผลตอบกลับจาก LINE — 200=สำเร็จ, 401=token ผิด, 400=payload ผิด/replyToken หมดอายุ
  Logger.log('↩️ LINE reply status=' + res.getResponseCode() + ' body=' + res.getContentText());
}

function startLoadingAnimation(chatId) {
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
      muteHttpExceptions: true,
      payload: JSON.stringify({ chatId: chatId, loadingSeconds: 5 }),
    });
  } catch (error) {
    console.error('Loading Animation Error:', error);
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🤖 จัดการแชทบอท')
    .addItem('🔄 อัปเดตข้อมูลให้บอท (ล้าง Cache)', 'manualClearCache')
    .addToUi();
}

function manualClearCache() {
  var cache = CacheService.getScriptCache();
  var totalChunks = cache.get(CACHE_KEY + '_total');
  if (totalChunks) {
    for (var i = 0; i < parseInt(totalChunks); i++) cache.remove(CACHE_KEY + '_chunk_' + i);
    cache.remove(CACHE_KEY + '_total');
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('บอทพร้อมตอบข้อมูลล่าสุดแล้ว', '✅ อัปเดต Cache สำเร็จ', 5);
}
