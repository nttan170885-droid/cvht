/**
 * Trợ lý Cố vấn học tập – Trường Dược, ĐHYD TP.HCM
 * Backend Google Apps Script (gắn với Google Sheet).
 *
 * Cloudflare Worker gọi doPost() kèm PROXY_KEY bí mật. Không ai gọi thẳng được.
 *
 * Sheet:
 *   NguoiDung  – danh sách sinh viên, CVHT, admin (đăng nhập)
 *   KienThuc   – kho kiến thức: mỗi dòng là 1 Điều / 1 đoạn văn bản (Trợ lý AI tìm trong đây)
 *   TaiLieu    – danh mục văn bản & mẫu đơn (tab "Tài liệu" trên web)
 *   NhapVanBan – nơi dán toàn văn 1 quy chế để tự tách thành từng Điều
 *   LichSuHoi  – lịch sử câu hỏi / trả lời (CVHT xem câu hỏi của SV mình phụ trách)
 *   NhatKy     – nhật ký đăng nhập, đổi mật khẩu
 *
 * Lần đầu: chọn hàm caiDat → ▶ Chạy. Nhật ký thực thi hiện PROXY_KEY và mật khẩu admin.
 */

var APP_VERSION = '2026.10.22';

var SH = {
  USERS: 'NguoiDung',
  KB: 'KienThuc',
  DOCS: 'TaiLieu',
  IMPORT: 'NhapVanBan',
  CHAT: 'LichSuHoi',
  LOG: 'NhatKy'
};

var HEADERS = {
  NguoiDung: ['TenDangNhap', 'HoTen', 'VaiTro', 'Lop', 'CVHT', 'Email', 'SoDienThoai', 'MatKhauMacDinh', 'MatKhauHash', 'Salt', 'TrangThai', 'LanDangNhapCuoi'],
  KienThuc: ['MaVB', 'TenVB', 'Muc', 'TieuDe', 'NoiDung', 'Link', 'TuKhoa', 'HieuLuc', 'CapNhat'],
  TaiLieu: ['Nhom', 'Ten', 'GhiChu', 'Link', 'HienThi'],
  LichSuHoi: ['ID', 'ThoiGian', 'TenDangNhap', 'HoTen', 'VaiTro', 'Lop', 'CVHT', 'CauHoi', 'TraLoi', 'Nguon', 'Model', 'DanhGia', 'GopY'],
  NhatKy: ['ThoiGian', 'TenDangNhap', 'HanhDong', 'ChiTiet', 'IP']
};

var TOKEN_DAYS = 7;          // phiên đăng nhập 7 ngày
var MAX_FAIL = 10;           // sai mật khẩu 10 lần → khóa 15 phút
var DEFAULT_LIMIT_SV = 20;   // câu hỏi AI / sinh viên / ngày
var DEFAULT_LIMIT_STAFF = 60; // câu hỏi AI / CVHT, admin / ngày
var TZ = 'Asia/Ho_Chi_Minh';

/* ============================== API ============================== */

function doGet() {
  return out_({ ok: true, app: 'cvht', version: APP_VERSION });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_({ ok: false, error: 'Dữ liệu gửi lên không hợp lệ.' });
  }
  var key = PropertiesService.getScriptProperties().getProperty('PROXY_KEY');
  if (!key || req.key !== key) return out_({ ok: false, error: 'Không có quyền truy cập.', code: 'FORBIDDEN' });

  try {
    switch (req.action) {
      // ---- gọi từ trình duyệt (qua Worker) ----
      case 'login': return out_(apiLogin_(req, key));
      case 'changePassword': return out_(apiChangePassword_(req, key));
      case 'me': return out_(apiMe_(req, key));
      case 'questions': return out_(apiQuestions_(req, key));
      case 'feedback': return out_(apiFeedback_(req, key));
      // ---- chỉ Worker gọi ----
      case 'health': return out_({ ok: true, version: APP_VERSION, kbVersion: kbVersion_() });
      case 'chatPrep': return out_(apiChatPrep_(req));
      case 'knowledge': return out_(apiKnowledge_());
      case 'logChat': return out_(apiLogChat_(req));
      default: return out_({ ok: false, error: 'Thao tác không hợp lệ: ' + req.action });
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return out_({ ok: false, error: 'Lỗi máy chủ: ' + (err && err.message ? err.message : String(err)) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================== Người dùng ============================== */

function normId_(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/** 'Sinh viên' → sv, 'CVHT' / 'Cố vấn' → cvht, 'Admin' / 'Quản trị' → admin */
function roleCode_(s) {
  var t = String(s || '').toLowerCase();
  if (t.indexOf('admin') >= 0 || t.indexOf('quản trị') >= 0 || t.indexOf('quan tri') >= 0) return 'admin';
  if (t.indexOf('cvht') >= 0 || t.indexOf('cố vấn') >= 0 || t.indexOf('co van') >= 0 || t.indexOf('giảng viên') >= 0) return 'cvht';
  return 'sv';
}

function roleLabel_(code) {
  return code === 'admin' ? 'Quản trị' : code === 'cvht' ? 'Cố vấn học tập' : 'Sinh viên';
}

/** Đọc toàn bộ NguoiDung → mảng object (kèm số dòng). */
function readUsers_() {
  var sh = sheet_(SH.USERS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var head = HEADERS.NguoiDung;
  var vals = sh.getRange(2, 1, last - 1, head.length).getValues();
  var list = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var id = normId_(r[0]);
    if (!id) continue;
    var o = { row: i + 2 };
    for (var j = 0; j < head.length; j++) o[head[j]] = r[j];
    o.id = id;
    o.role = roleCode_(o.VaiTro);
    list.push(o);
  }
  return list;
}

function findUser_(users, id) {
  id = normId_(id);
  for (var i = 0; i < users.length; i++) if (users[i].id === id) return users[i];
  return null;
}

/** CVHT phụ trách có thể ghi bằng email, tên đăng nhập, hoặc họ tên → tìm người CVHT tương ứng. */
function findAdvisor_(users, ref) {
  var r = normId_(ref);
  if (!r) return null;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (u.role === 'sv') continue;
    if (u.id === r || normId_(u.Email) === r || normId_(u.HoTen) === r) return u;
  }
  return null;
}

/** Sinh viên này có thuộc CVHT kia không. */
function belongsTo_(student, advisor) {
  var r = normId_(student.CVHT);
  if (!r) return false;
  return r === advisor.id || (advisor.Email && r === normId_(advisor.Email)) || r === normId_(advisor.HoTen);
}

/** Mật khẩu mặc định: nếu admin dán ngày sinh dạng ngày tháng thì đổi thành ddmmyyyy. */
function defaultPassword_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, TZ, 'ddMMyyyy');
  return String(v == null ? '' : v).trim();
}

/** So khớp mật khẩu mặc định: chấp nhận 01/02/2004, 01-02-2004, 01022004 như nhau. */
function sameDefault_(input, def) {
  if (!def) return false;
  if (input === def) return true;
  var a = String(input).replace(/[\s\/\-\.]/g, '');
  var b = String(def).replace(/[\s\/\-\.]/g, '');
  return a.length > 0 && a === b;
}

function hashPw_(salt, pw) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8);
  var h = bytesToHex_(bytes);
  for (var i = 0; i < 499; i++) {
    h = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function bytesToHex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

function randomHex_(n) {
  var s = '';
  while (s.length < n) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, n);
}

function randomPassword_() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  var s = '';
  var hex = randomHex_(24);
  for (var i = 0; i < 10; i++) s += chars.charAt(parseInt(hex.substr(i * 2, 2), 16) % chars.length);
  return s;
}

/* ============================== Token ============================== */
// payload = base64url(JSON) ; chữ ký = base64url(HMAC-SHA256(payload, PROXY_KEY)).
// Worker kiểm tra lại chữ ký bằng cùng thuật toán (src/worker.js → verifyToken).

function b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function signToken_(data, key) {
  var payload = b64url_(Utilities.newBlob(JSON.stringify(data)).getBytes());
  var sig = b64url_(Utilities.computeHmacSha256Signature(payload, key));
  return payload + '.' + sig;
}

function verifyToken_(token, key) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  var parts = token.split('.');
  var expect = b64url_(Utilities.computeHmacSha256Signature(parts[0], key));
  if (expect !== parts[1]) return null;
  try {
    var pad = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    var data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString());
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function makeSession_(u, users, key) {
  var advisor = u.role === 'sv' ? findAdvisor_(users, u.CVHT) : null;
  var data = {
    u: u.id,
    r: u.role,
    n: String(u.HoTen || u.id),
    l: String(u.Lop || ''),
    c: advisor ? String(advisor.HoTen) : String(u.CVHT || ''),
    exp: Date.now() + TOKEN_DAYS * 86400000
  };
  return signToken_(data, key);
}

/* ============================== Đăng nhập ============================== */

function apiLogin_(req, key) {
  var id = normId_(req.username);
  var pw = String(req.password == null ? '' : req.password);
  if (!id || !pw) return { ok: false, error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' };

  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + id;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAIL) return { ok: false, error: 'Tài khoản tạm khóa 15 phút do nhập sai nhiều lần.' };

  var users = readUsers_();
  var u = findUser_(users, id);
  var ok = false;
  var mustChange = false;
  if (u && String(u.TrangThai || '').toLowerCase().indexOf('khóa') < 0) {
    if (u.MatKhauHash) {
      ok = hashPw_(String(u.Salt), pw) === String(u.MatKhauHash);
    } else {
      ok = sameDefault_(pw, defaultPassword_(u.MatKhauMacDinh));
      mustChange = ok;
    }
  }
  if (!ok) {
    cache.put(failKey, String(fails + 1), 900);
    log_(id, 'Đăng nhập sai', u ? '' : 'Không có trong danh sách', req.ip);
    return { ok: false, error: 'Tên đăng nhập hoặc mật khẩu không đúng.' };
  }
  cache.remove(failKey);
  sheet_(SH.USERS).getRange(u.row, 12).setValue(new Date());
  log_(id, 'Đăng nhập', roleLabel_(u.role), req.ip);
  return {
    ok: true,
    token: makeSession_(u, users, key),
    mustChange: mustChange,
    user: publicUser_(u, users)
  };
}

function publicUser_(u, users) {
  var o = {
    id: u.id,
    name: String(u.HoTen || u.id),
    role: u.role,
    roleLabel: roleLabel_(u.role),
    lop: String(u.Lop || ''),
    email: String(u.Email || '')
  };
  if (u.role === 'sv') {
    var a = findAdvisor_(users, u.CVHT);
    o.advisor = a
      ? { name: String(a.HoTen || ''), email: String(a.Email || (a.id.indexOf('@') > 0 ? a.id : '')), phone: String(a.SoDienThoai || '') }
      : (u.CVHT ? { name: String(u.CVHT), email: '', phone: '' } : null);
  } else {
    var n = 0;
    var classes = {};
    for (var i = 0; i < users.length; i++) {
      var s = users[i];
      if (s.role === 'sv' && (u.role === 'admin' || belongsTo_(s, u))) {
        n++;
        if (s.Lop) classes[String(s.Lop)] = (classes[String(s.Lop)] || 0) + 1;
      }
    }
    o.studentCount = n;
    o.classes = Object.keys(classes).sort().map(function (k) { return { lop: k, count: classes[k] }; });
  }
  return o;
}

function apiChangePassword_(req, key) {
  var s = requireSessionSafe_(req, key);
  if (!s) return authFail_();
  var oldPw = String(req.oldPassword || '');
  var newPw = String(req.newPassword || '');
  if (newPw.length < 8) return { ok: false, error: 'Mật khẩu mới phải có ít nhất 8 ký tự.' };
  if (!/[A-Za-z]/.test(newPw) || !/\d/.test(newPw)) return { ok: false, error: 'Mật khẩu mới cần có cả chữ và số.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var users = readUsers_();
    var u = findUser_(users, s.u);
    if (!u) return authFail_();
    var def = defaultPassword_(u.MatKhauMacDinh);
    var okOld = u.MatKhauHash ? hashPw_(String(u.Salt), oldPw) === String(u.MatKhauHash) : sameDefault_(oldPw, def);
    if (!okOld) return { ok: false, error: 'Mật khẩu hiện tại không đúng.' };
    if (sameDefault_(newPw, def) || newPw === oldPw) return { ok: false, error: 'Mật khẩu mới phải khác mật khẩu cũ.' };
    var salt = randomHex_(16);
    var sh = sheet_(SH.USERS);
    sh.getRange(u.row, 8, 1, 3).setValues([['', hashPw_(salt, newPw), salt]]);
    log_(u.id, 'Đổi mật khẩu', '', req.ip);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function requireSessionSafe_(req, key) {
  return verifyToken_(req.token, key);
}

function authFail_() {
  return { ok: false, error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', code: 'AUTH' };
}

/** Thông tin khi mở app: người dùng + danh mục tài liệu. */
function apiMe_(req, key) {
  var s = requireSessionSafe_(req, key);
  if (!s) return authFail_();
  var users = readUsers_();
  var u = findUser_(users, s.u);
  if (!u || String(u.TrangThai || '').toLowerCase().indexOf('khóa') >= 0) return authFail_();
  var kb = readKnowledgeRows_();
  return {
    ok: true,
    user: publicUser_(u, users),
    mustChange: !u.MatKhauHash,
    docs: readDocs_(),
    kb: { chunks: kb.length, docs: countDistinct_(kb, 'MaVB') },
    limit: dailyLimit_(u.role),
    used: usedToday_(u.id),
    version: APP_VERSION
  };
}

/** CVHT xem câu hỏi của SV mình phụ trách; admin xem tất cả. */
function apiQuestions_(req, key) {
  var s = requireSessionSafe_(req, key);
  if (!s) return authFail_();
  if (s.r === 'sv') return { ok: false, error: 'Chức năng dành cho CVHT.' };
  var users = readUsers_();
  var me = findUser_(users, s.u);
  if (!me) return authFail_();

  var sh = sheet_(SH.CHAT);
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, items: [] };
  var from = Math.max(2, last - 3000 + 1);
  var vals = sh.getRange(from, 1, last - from + 1, HEADERS.LichSuHoi.length).getValues();

  var mine = {};
  if (me.role === 'cvht') {
    for (var i = 0; i < users.length; i++) if (users[i].role === 'sv' && belongsTo_(users[i], me)) mine[users[i].id] = true;
  }
  var items = [];
  for (var k = vals.length - 1; k >= 0 && items.length < 300; k--) {
    var r = vals[k];
    if (roleCode_(r[4]) !== 'sv') continue;
    if (me.role === 'cvht' && !mine[normId_(r[2])]) continue;
    items.push({
      id: String(r[0]),
      time: r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
      user: String(r[2]),
      name: String(r[3]),
      lop: String(r[5]),
      q: String(r[7]),
      a: String(r[8]),
      sources: String(r[9]),
      rating: r[11] === '' ? 0 : Number(r[11]) || 0,
      note: String(r[12] || '')
    });
  }
  return { ok: true, items: items, scope: me.role === 'admin' ? 'all' : 'mine' };
}

function apiFeedback_(req, key) {
  var s = requireSessionSafe_(req, key);
  if (!s) return authFail_();
  var id = String(req.id || '');
  var rating = Number(req.rating) > 0 ? 1 : Number(req.rating) < 0 ? -1 : 0;
  if (!id) return { ok: false, error: 'Thiếu mã câu hỏi.' };
  var sh = sheet_(SH.CHAT);
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'Không tìm thấy câu hỏi.' };
  var from = Math.max(2, last - 2000 + 1);
  var ids = sh.getRange(from, 1, last - from + 1, 3).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === id) {
      if (normId_(ids[i][2]) !== s.u) return { ok: false, error: 'Không có quyền.' };
      sh.getRange(from + i, 12, 1, 2).setValues([[rating, String(req.note || '').slice(0, 500)]]);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Không tìm thấy câu hỏi (có thể đang được ghi, thử lại sau ít giây).' };
}

/* ============================== Trợ lý AI (Worker gọi) ============================== */

function dailyLimit_(role) {
  var p = PropertiesService.getScriptProperties();
  if (role === 'sv') return Number(p.getProperty('DAILY_LIMIT_SV')) || DEFAULT_LIMIT_SV;
  return Number(p.getProperty('DAILY_LIMIT_STAFF')) || DEFAULT_LIMIT_STAFF;
}

function todayKey_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
}

function usedToday_(id) {
  return Number(PropertiesService.getScriptProperties().getProperty('q_' + todayKey_() + '_' + normId_(id)) || 0);
}

/** Trước mỗi câu hỏi: kiểm tra hạn mức trong ngày, trả phiên bản kho kiến thức. */
function apiChatPrep_(req) {
  var id = normId_(req.user);
  if (!id) return { ok: false, error: 'Thiếu người dùng.' };
  var limit = dailyLimit_(req.role);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var p = PropertiesService.getScriptProperties();
    var day = todayKey_();
    var k = 'q_' + day + '_' + id;
    var used = Number(p.getProperty(k) || 0);
    if (used >= limit) {
      return { ok: false, code: 'QUOTA', error: 'Bạn đã dùng hết ' + limit + ' câu hỏi hôm nay. Vui lòng quay lại vào ngày mai.' };
    }
    p.setProperty(k, String(used + 1));
    if (Math.random() < 0.03) cleanupQuota_(p, day);
    return { ok: true, remaining: limit - used - 1, limit: limit, kbVersion: kbVersion_() };
  } finally {
    lock.releaseLock();
  }
}

function cleanupQuota_(p, day) {
  var all = p.getKeys();
  for (var i = 0; i < all.length; i++) {
    if (all[i].indexOf('q_') === 0 && all[i].substr(2, 8) !== day) p.deleteProperty(all[i]);
  }
}

function kbVersion_() {
  var p = PropertiesService.getScriptProperties();
  var v = p.getProperty('KB_VERSION');
  if (!v) {
    v = String(Date.now());
    p.setProperty('KB_VERSION', v);
  }
  return v;
}

function bumpKb_() {
  PropertiesService.getScriptProperties().setProperty('KB_VERSION', String(Date.now()));
}

function readKnowledgeRows_() {
  var sh = sheet_(SH.KB);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var head = HEADERS.KienThuc;
  var vals = sh.getRange(2, 1, last - 1, head.length).getValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (!String(r[4]).trim() && !String(r[3]).trim()) continue;
    var hl = String(r[7] || '').toLowerCase();
    if (hl.indexOf('không') >= 0 || hl.indexOf('het') >= 0 || hl.indexOf('hết') >= 0) continue;
    var o = {};
    for (var j = 0; j < head.length; j++) o[head[j]] = r[j];
    rows.push(o);
  }
  return rows;
}

function readDocs_() {
  var sh = sheet_(SH.DOCS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, HEADERS.TaiLieu.length).getValues();
  var docs = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (!String(r[1]).trim()) continue;
    var show = String(r[4]).toLowerCase();
    if (show.indexOf('không') >= 0 || show === 'an' || show === 'ẩn') continue;
    docs.push({ group: String(r[0] || 'Khác'), name: String(r[1]), note: String(r[2] || ''), link: String(r[3] || '') });
  }
  return docs;
}

function countDistinct_(rows, field) {
  var m = {};
  for (var i = 0; i < rows.length; i++) m[String(rows[i][field])] = 1;
  return Object.keys(m).length;
}

/** Toàn bộ kho kiến thức cho Worker (Worker tự tìm trích đoạn liên quan). */
function apiKnowledge_() {
  var rows = readKnowledgeRows_();
  var chunks = rows.map(function (o) {
    return {
      doc: String(o.TenVB || o.MaVB || ''),
      code: String(o.MaVB || ''),
      muc: String(o.Muc || ''),
      title: String(o.TieuDe || ''),
      text: String(o.NoiDung || ''),
      link: String(o.Link || ''),
      kw: String(o.TuKhoa || '')
    };
  });
  // Mẫu đơn / tài liệu cũng tìm được (để AI chỉ đúng link mẫu đơn)
  readDocs_().forEach(function (d) {
    chunks.push({ doc: d.name, code: 'TL', muc: d.group, title: d.name, text: d.note, link: d.link, kw: 'mẫu đơn biểu mẫu tài liệu ' + d.group, isDoc: true });
  });
  return { ok: true, version: kbVersion_(), chunks: chunks };
}

function apiLogChat_(req) {
  var sh = sheet_(SH.CHAT);
  sh.appendRow([
    String(req.id || ''),
    new Date(),
    "'" + String(req.user || ''),
    String(req.name || ''),
    roleLabel_(req.role),
    String(req.lop || ''),
    String(req.cvht || ''),
    String(req.question || '').slice(0, 4000),
    String(req.answer || '').slice(0, 20000),
    String(req.sources || '').slice(0, 2000),
    String(req.model || ''),
    '',
    ''
  ]);
  return { ok: true };
}

/* ============================== Nhật ký ============================== */

function log_(user, action, detail, ip) {
  try {
    sheet_(SH.LOG).appendRow([new Date(), "'" + String(user || ''), action, String(detail || ''), String(ip || '')]);
  } catch (e) {
    console.error(e);
  }
}

/* ============================== Tiện ích Sheet ============================== */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Chưa có sheet "' + name + '". Hãy chạy hàm caiDat.');
  return sh;
}

function ensureSheet_(name, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (headers && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0e5e52').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ============================== Menu & cài đặt ============================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎓 Trợ lý CVHT')
    .addItem('1. Cài đặt lần đầu', 'caiDat')
    .addSeparator()
    .addItem('Tách văn bản ở sheet NhapVanBan thành từng Điều', 'tachVanBan')
    .addItem('Đặt lại mật khẩu cho dòng đang chọn (NguoiDung)', 'datLaiMatKhau')
    .addItem('Làm mới kho kiến thức cho Trợ lý AI', 'lamMoiKhoKienThuc')
    .addSeparator()
    .addItem('Xem PROXY_KEY', 'xemProxyKey')
    .addToUi();
}

/** Sửa KienThuc / TaiLieu trên Sheet → Worker tự nạp lại kho kiến thức. */
function onEdit(e) {
  try {
    var name = e && e.range ? e.range.getSheet().getName() : '';
    if (name === SH.KB || name === SH.DOCS) bumpKb_();
  } catch (err) {
    // bỏ qua
  }
}

function caiDat() {
  var p = PropertiesService.getScriptProperties();
  var key = p.getProperty('PROXY_KEY');
  if (!key) {
    key = randomHex_(48);
    p.setProperty('PROXY_KEY', key);
  }

  var users = ensureSheet_(SH.USERS, HEADERS.NguoiDung);
  users.getRange('A:A').setNumberFormat('@'); // giữ số 0 đầu MSSV
  users.getRange('H:H').setNumberFormat('@'); // mật khẩu mặc định dạng chữ
  var kb = ensureSheet_(SH.KB, HEADERS.KienThuc);
  var docs = ensureSheet_(SH.DOCS, HEADERS.TaiLieu);
  ensureSheet_(SH.CHAT, HEADERS.LichSuHoi);
  ensureSheet_(SH.LOG, HEADERS.NhatKy);
  setupImportSheet_();

  var adminPw = null;
  var list = readUsers_();
  var hasAdmin = list.some(function (u) { return u.role === 'admin'; });
  if (!hasAdmin) {
    adminPw = randomPassword_();
    users.appendRow(['admin', 'Quản trị hệ thống', 'Admin', '', '', '', '', adminPw, '', '', 'Hoạt động', '']);
  }

  if (docs.getLastRow() < 2) {
    var d = seedDocs_();
    docs.getRange(2, 1, d.length, d[0].length).setValues(d);
  }
  if (kb.getLastRow() < 2) {
    var k = seedKnowledge_();
    kb.getRange(2, 1, k.length, k[0].length).setValues(k);
  }
  try {
    users.setColumnWidth(2, 200);
    kb.setColumnWidth(5, 600);
    docs.setColumnWidth(2, 320);
    docs.setColumnWidth(4, 320);
  } catch (e) {}
  bumpKb_();

  console.log('PROXY_KEY = ' + key);
  console.log('→ Dán giá trị này vào Secret PROXY_KEY trên Cloudflare.');
  if (adminPw) console.log('Tài khoản quản trị: admin / ' + adminPw + '  (đăng nhập xong sẽ phải đổi mật khẩu)');
  try {
    SpreadsheetApp.getUi().alert(
      'Đã cài đặt xong.\n\nPROXY_KEY và mật khẩu admin nằm trong Nhật ký thực thi của Apps Script (Xem → Nhật ký thực thi).\n\nTiếp theo: Triển khai → Tùy chọn triển khai mới → Ứng dụng web (Thực thi: Tôi · Ai có quyền truy cập: Bất kỳ ai).'
    );
  } catch (e) {}
}

function xemProxyKey() {
  var key = PropertiesService.getScriptProperties().getProperty('PROXY_KEY') || '(chưa có – hãy chạy Cài đặt lần đầu)';
  SpreadsheetApp.getUi().alert('PROXY_KEY:\n\n' + key + '\n\nChỉ dán vào Cloudflare (Secret). Không gửi cho người khác.');
}

function lamMoiKhoKienThuc() {
  bumpKb_();
  var n = readKnowledgeRows_().length;
  SpreadsheetApp.getUi().alert('Đã làm mới. Kho kiến thức có ' + n + ' đoạn. Trợ lý AI dùng nội dung mới từ câu hỏi tiếp theo.');
}

function datLaiMatKhau() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SH.USERS) {
    ui.alert('Hãy mở sheet NguoiDung và chọn ô trên dòng của người cần đặt lại.');
    return;
  }
  var row = sh.getActiveCell().getRow();
  if (row < 2) {
    ui.alert('Hãy chọn dòng của một người dùng.');
    return;
  }
  var r = sh.getRange(row, 1, 1, 3).getValues()[0];
  if (!String(r[0]).trim()) {
    ui.alert('Dòng này chưa có tên đăng nhập.');
    return;
  }
  var res = ui.prompt(
    'Đặt lại mật khẩu cho ' + r[1] + ' (' + r[0] + ')',
    'Nhập mật khẩu tạm (sinh viên thường dùng ngày sinh ddmmyyyy). Để trống để tạo ngẫu nhiên.',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var pw = res.getResponseText().trim() || randomPassword_();
  sh.getRange(row, 8, 1, 3).setNumberFormat('@').setValues([[pw, '', '']]);
  CacheService.getScriptCache().remove('fail_' + normId_(r[0]));
  log_(normId_(r[0]), 'Admin đặt lại mật khẩu', '', '');
  ui.alert('Mật khẩu tạm của ' + r[0] + ': ' + pw + '\nNgười dùng sẽ phải đổi mật khẩu khi đăng nhập.');
}

/* ============================== Nhập văn bản ============================== */

function setupImportSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SH.IMPORT);
  if (sh) return sh;
  sh = ss.insertSheet(SH.IMPORT);
  sh.getRange('A1:A4').setValues([['Mã văn bản (VD: QCDT)'], ['Tên văn bản'], ['Link văn bản gốc'], ['Hướng dẫn: điền B1–B3, dán toàn văn từ ô A6 trở xuống (mỗi dòng 1 ô), rồi chọn menu 🎓 Trợ lý CVHT → Tách văn bản.']]);
  sh.getRange('A1:A3').setFontWeight('bold');
  sh.getRange('A4').setFontStyle('italic').setFontColor('#5b716c');
  sh.getRange('A5').setValue('NỘI DUNG (dán từ ô A6)').setFontWeight('bold').setBackground('#e2f0ec');
  sh.setColumnWidth(1, 700);
  sh.setColumnWidth(2, 380);
  return sh;
}

function tachVanBan() {
  var ui = SpreadsheetApp.getUi();
  var sh = setupImportSheet_();
  var code = String(sh.getRange('B1').getValue()).trim();
  var name = String(sh.getRange('B2').getValue()).trim();
  var link = String(sh.getRange('B3').getValue()).trim();
  if (!code || !name) {
    ui.alert('Điền Mã văn bản (B1) và Tên văn bản (B2) trước.');
    return;
  }
  var last = sh.getLastRow();
  if (last < 6) {
    ui.alert('Chưa có nội dung. Dán toàn văn từ ô A6 trở xuống.');
    return;
  }
  var lines = sh.getRange(6, 1, last - 5, 1).getDisplayValues().map(function (r) { return r[0]; });
  var parts = splitArticles(lines.join('\n'));
  if (!parts.length) {
    ui.alert('Không tách được đoạn nào.');
    return;
  }
  var kb = sheet_(SH.KB);
  var lastKb = kb.getLastRow();
  var keep = [];
  var removed = 0;
  if (lastKb >= 2) {
    var vals = kb.getRange(2, 1, lastKb - 1, HEADERS.KienThuc.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === code) removed++;
      else keep.push(vals[i]);
    }
  }
  var now = new Date();
  var add = parts.map(function (p) {
    return [code, name, p.muc, p.title, p.text, link, p.chuong || '', 'Còn hiệu lực', now];
  });
  var all = keep.concat(add);
  if (lastKb >= 2) kb.getRange(2, 1, lastKb - 1, HEADERS.KienThuc.length).clearContent();
  kb.getRange(2, 1, all.length, HEADERS.KienThuc.length).setValues(all);
  bumpKb_();
  ui.alert('Đã tách "' + name + '" thành ' + add.length + ' đoạn' + (removed ? ' (thay ' + removed + ' đoạn cũ cùng mã ' + code + ')' : '') + '.\nCó thể xóa nội dung ở sheet NhapVanBan.');
}

/**
 * Tách toàn văn thành từng Điều. Điều dài được chia nhỏ (≤ 3.500 ký tự) theo đoạn.
 * Văn bản không có "Điều" (thông báo, kế hoạch) được chia theo đoạn ~2.000 ký tự.
 */
function splitArticles(text) {
  var lines = String(text || '').replace(/\r/g, '').split('\n');
  var parts = [];
  var chuong = '';
  var pendingChapterTitle = false;
  var cur = { muc: 'Phần mở đầu', title: '', chuong: '', body: [] };
  var found = false;
  var reChuong = /^(chương|chuong)\s+([ivxlc]+|\d+)\b[\.:\s\-–—]*(.*)$/i;
  var reDieu = /^điều\s+(\d+[a-zđ]?)\s*[\.:\-–]?\s*(.*)$/i;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+/g, ' ').trim();
    if (!line) {
      cur.body.push('');
      continue;
    }
    var m = line.match(reChuong);
    if (m) {
      chuong = 'Chương ' + m[2].toUpperCase() + (m[3] ? ' – ' + m[3] : '');
      pendingChapterTitle = !m[3];
      continue;
    }
    if (pendingChapterTitle && !reDieu.test(line)) {
      chuong += ' – ' + line;
      pendingChapterTitle = false;
      continue;
    }
    pendingChapterTitle = false;
    m = line.match(reDieu);
    if (m) {
      found = true;
      flushPart_(parts, cur);
      cur = { muc: 'Điều ' + m[1], title: m[2] || '', chuong: chuong, body: [] };
      continue;
    }
    cur.body.push(line);
  }
  flushPart_(parts, cur);
  if (!found) {
    // Không có Điều: chia theo đoạn
    var all = parts.map(function (p) { return p.text; }).join('\n\n');
    parts = [];
    var chunks = chunkText_(all, 2000);
    for (var k = 0; k < chunks.length; k++) parts.push({ muc: 'Đoạn ' + (k + 1), title: '', chuong: '', text: chunks[k] });
    return parts;
  }
  // Chia nhỏ Điều quá dài
  var outParts = [];
  for (var j = 0; j < parts.length; j++) {
    var p = parts[j];
    if (p.text.length <= 3500) {
      outParts.push(p);
      continue;
    }
    var pieces = chunkText_(p.text, 3000);
    for (var q = 0; q < pieces.length; q++) {
      outParts.push({ muc: p.muc + ' (phần ' + (q + 1) + ')', title: p.title, chuong: p.chuong, text: pieces[q] });
    }
  }
  return outParts;
}

function flushPart_(parts, cur) {
  var text = cur.body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text && !cur.title) return;
  if (cur.muc === 'Phần mở đầu' && text.length < 40) return;
  parts.push({ muc: cur.muc, title: cur.title, chuong: cur.chuong, text: text });
}

function chunkText_(text, size) {
  var paras = String(text).split(/\n/);
  var out = [];
  var buf = '';
  for (var i = 0; i < paras.length; i++) {
    var para = paras[i];
    if (buf && (buf.length + para.length + 1) > size) {
      out.push(buf.trim());
      buf = '';
    }
    while (para.length > size) {
      out.push(para.slice(0, size));
      para = para.slice(size);
    }
    buf += (buf ? '\n' : '') + para;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/* ============================== Dữ liệu ban đầu ============================== */
// Lấy từ tài liệu "Quy định liên quan cố vấn học tập" (NH 2026-2027).

var LINKS = {
  QDCVHT: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQCEUdZPWfESRYCnbznMikKbAcPLrYvMH40Z-ZuYYJT98xE?e=ySIloE',
  KHDT: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQD58F_w1_IVQb1WGRdhcQLDAW3q8qzL6j0Ia1-_B4B-kKQ?e=ANgBsB',
  QCDT: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/EYiOPKR-oXtJgyntHapUm-kBXwdcedSDf3HCRa0df_ESmQ?e=nyOdb8',
  QCCTSV: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQBYZSuctrmPRq6RvPzwkGAPAXokcI3ioa2pN246BlYZBao?e=G17vgR',
  HOCBONG: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQCwms707nWBT5xJLuM5V5V1AZdrc76gyrSFAY8yQ1eTa1c?e=cri72a',
  DRL: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/EchII9ZOkVlIogN4gZwcYbYBEawqCMoDwMRVZeK-xfTfmQ?e=Ejes8a',
  PHIEUDRL: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/EY9GxvndiU1NiOj-MBmYvE8B5kq0zr3NDMwx4AyPRcaxDA?e=ppI6oF',
  VPTHI: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/ESgJW9Cp_bhMnYgrrF7cYfEBrzXT1GTHdGqeiswuQdaGKA?e=nxqGCd',
  CDRNN: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQABng6l44_TTKGU9eLwt1_7AfJP1WdRoURreVBIYWjyJTI?e=DKZTJx',
  TBTA: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQDBfDrvzsqUSJj3OEMCoG17AVnpsb-k9F2CGjgWZbIof10?e=vUOWZ1',
  HOCPHI: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQAD-c1ZkI4HS6R8WhhxeSMwAXFxHbKe-gH9TyiU-mMi07k?e=hIrnD7',
  HDHP: 'https://sv.ump.edu.vn/sinh-vien/tin-tuc/phim-huong-dan-dong-hoc-phi-qua-ung-dung-di-dong-oneuni-va-trang-svumpeduvn.html?pIDDanhMuc=13',
  HDPHI: 'https://sv.ump.edu.vn/sinh-vien/tin-tuc/huong-dan-nop-cac-khoan-phi-tai-dai-hoc-y-duoc-thanh-pho-ho-chi-minh.html?pIDDanhMuc=13',
  TBHP: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQC4rKsbTKfxQrIglW0WqUFrARUFL1xE-aNMA-n_n9ocr3U?e=wSF3iB',
  HOTRO: 'https://umpedu-my.sharepoint.com/:b:/g/personal/ree_sp_ump_edu_vn/IQDvSGCPPeR6QJRSgqoh5gG1AccK_Kk1U7EeOw-GYE2Waco?e=vTONQx',
  DONHOTRO: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/IQAom89lC6xnQbeKPc8VSuIeAcHooysuL11gAntQC1ggGGg?e=3hWd4z',
  THAMVAN: 'https://sv.ump.edu.vn/sinh-vien/tin-tuc/thong-tin-phong-tham-van.html?pIDDanhMuc=11',
  BIEUMAU: 'https://sv.ump.edu.vn/sinh-vien/tin-tuc/huong-dan-de-xuat-bieu-mau-030718.html?pIDDanhMuc=13',
  DONPK: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/IQD3O5-E1Y0bR4RulzI37OghAWcJj4eDBurS-558ZlpS5Ck?e=ygqUAF',
  DONTHE: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/IQC0qX4QWp21S54vheqF5o53ATduJJ2JTxlrRn-EtCWAhWg?e=s95EQR',
  DONNGHI: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/IQCqoq2FVghCSKHnoWW75hrEAaUjfg2RR8j3fUXmm_A6J3A?e=XhxYbJ',
  DONHOCLAI: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/IQAS5tfC-p3cR4oRTxNkyJFfARdVEG2uCOJgQGlT1RQ3PA8?e=bdqqSq',
  DONTHOI: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/IQC0aKqrBuR3T50iRUCaTeqFAcwkFVwmvIcESQCKJTkjxBM?e=HrkWSv',
  DONHOAN: 'https://umpedu-my.sharepoint.com/:w:/g/personal/ree_sp_ump_edu_vn/IQAskxYQT1FuTK_ReghxOuNCAc17K22QURKXXw0CTB4oOcI?e=jYReDs',
  EPORT: 'https://forms.cloud.microsoft/r/XCUr50EUdX'
};

function seedDocs_() {
  var L = LINKS;
  return [
    ['Cố vấn học tập', 'Quyết định CVHT Trường Dược NH 2026-2027 (5337)', 'Danh sách cố vấn học tập các lớp', L.QDCVHT, 'Có'],
    ['Đào tạo', 'Kế hoạch đào tạo NH 2026-2027 (2035)', 'Lịch học kỳ, thi, nghỉ lễ của năm học', L.KHDT, 'Có'],
    ['Đào tạo', 'Quy chế đào tạo đại học (838)', 'Chú ý Điều 9, 10', L.QCDT, 'Có'],
    ['Đào tạo', 'Quy định xử lý vi phạm quy chế thi (2971)', '', L.VPTHI, 'Có'],
    ['Đào tạo', 'Quy định chuẩn đầu ra ngoại ngữ (792)', '', L.CDRNN, 'Có'],
    ['Đào tạo', 'Thông báo nộp minh chứng tiếng Anh xét chuẩn đầu ra (5333)', 'Tham khảo', L.TBTA, 'Có'],
    ['Công tác sinh viên', 'Quy chế công tác sinh viên ĐHYD TP.HCM (959)', 'Chú ý Chương III và Phụ lục', L.QCCTSV, 'Có'],
    ['Công tác sinh viên', 'Quy chế đánh giá kết quả rèn luyện (5158)', 'Chú ý Điều 14, 15', L.DRL, 'Có'],
    ['Công tác sinh viên', 'Phiếu đánh giá kết quả rèn luyện (1706)', 'Mẫu phiếu tự đánh giá', L.PHIEUDRL, 'Có'],
    ['Công tác sinh viên', 'Quy định hỗ trợ sinh viên gặp khó khăn đột xuất (3767)', '', L.HOTRO, 'Có'],
    ['Công tác sinh viên', 'Phòng tham vấn tâm lý', 'Thông tin liên hệ, đặt lịch tham vấn', L.THAMVAN, 'Có'],
    ['Học bổng & học phí', 'Quy định chính sách học bổng cho SV đại học chính quy (2651)', 'Chú ý Chương III', L.HOCBONG, 'Có'],
    ['Học bổng & học phí', 'Quyết định mức thu học phí NH 2026-2027 (3124)', '', L.HOCPHI, 'Có'],
    ['Học bổng & học phí', 'Thông báo về việc đóng học phí NH 2026-2027 (2383)', '', L.TBHP, 'Có'],
    ['Học bổng & học phí', 'Hướng dẫn đóng học phí qua OneUni và trang sv.ump.edu.vn', 'Cập nhật công nợ trực tiếp trên trang sinh viên', L.HDHP, 'Có'],
    ['Học bổng & học phí', 'Hướng dẫn nộp các khoản phí tại ĐHYD TP.HCM', '', L.HDPHI, 'Có'],
    ['Mẫu đơn', 'Đơn xin phúc khảo', '', L.DONPK, 'Có'],
    ['Mẫu đơn', 'Đơn xin cấp lại thẻ sinh viên', '', L.DONTHE, 'Có'],
    ['Mẫu đơn', 'Đơn xin nghỉ học tạm thời', '', L.DONNGHI, 'Có'],
    ['Mẫu đơn', 'Đơn xin nhập học lại (sau nghỉ học tạm thời)', '', L.DONHOCLAI, 'Có'],
    ['Mẫu đơn', 'Đơn xin thôi học', '', L.DONTHOI, 'Có'],
    ['Mẫu đơn', 'Đơn xin hoãn thi', '', L.DONHOAN, 'Có'],
    ['Mẫu đơn', 'Đơn xin xét hỗ trợ khó khăn đột xuất', '', L.DONHOTRO, 'Có'],
    ['Mẫu đơn', 'Hướng dẫn đề xuất biểu mẫu trên trang sinh viên', 'Đề xuất giấy xác nhận, biểu mẫu trực tuyến', L.BIEUMAU, 'Có'],
    ['Khác', 'Nộp E-portfolio', 'Biểu mẫu đăng tải E-portfolio cho sinh viên', L.EPORT, 'Có']
  ];
}

/**
 * Kho kiến thức ban đầu: chỉ là "phiếu giới thiệu" từng văn bản (chưa có toàn văn).
 * Khi có file PDF, dùng sheet NhapVanBan để nạp toàn văn theo từng Điều.
 */
function seedKnowledge_() {
  var L = LINKS;
  var now = new Date();
  var NOTE = 'Kho tài liệu hiện mới có thông tin giới thiệu văn bản này, chưa có toàn văn. Xem chi tiết tại link văn bản gốc.';
  function row(code, name, muc, title, text, link, kw) {
    return [code, name, muc, title, text + '\n' + NOTE, link, kw, 'Còn hiệu lực', now];
  }
  return [
    row('QDCVHT', 'Quyết định cố vấn học tập Trường Dược NH 2026-2027 (số 5337)', 'Giới thiệu', 'Danh sách cố vấn học tập',
      'Quyết định 5337 phân công cố vấn học tập (CVHT) cho các lớp của Trường Dược trong năm học 2026-2027 (bản cập nhật). Sinh viên muốn biết CVHT của lớp mình xem trong quyết định này hoặc xem mục "Của tôi" trên ứng dụng.',
      L.QDCVHT, 'cố vấn học tập cvht phân công lớp giảng viên chủ nhiệm'),
    row('KHDT', 'Kế hoạch đào tạo năm học 2026-2027 (số 2035)', 'Giới thiệu', 'Kế hoạch năm học',
      'Kế hoạch đào tạo năm học 2026-2027 của ĐHYD TP.HCM: thời gian bắt đầu, kết thúc các học kỳ, đợt thi, thời gian nghỉ lễ, nghỉ hè và các mốc của năm học.',
      L.KHDT, 'kế hoạch năm học lịch học học kỳ lịch thi nghỉ tết nghỉ hè'),
    row('QCDT', 'Quy chế đào tạo đại học (số 838)', 'Giới thiệu', 'Quy chế đào tạo trình độ đại học',
      'Quy chế đào tạo trình độ đại học của ĐHYD TP.HCM: tổ chức đào tạo theo tín chỉ, đăng ký học phần, đánh giá và tính điểm học phần, điểm trung bình, xếp loại học lực, cảnh báo kết quả học tập, buộc thôi học, nghỉ học tạm thời, học lại, chuyển ngành, điều kiện tốt nghiệp. Khi làm công tác cố vấn học tập cần chú ý Điều 9 và Điều 10.',
      L.QCDT, 'quy chế đào tạo tín chỉ học phần điểm trung bình cảnh báo học tập buộc thôi học nghỉ học tạm thời tốt nghiệp'),
    row('QCCTSV', 'Quy chế công tác sinh viên ĐHYD TP.HCM (số 959)', 'Giới thiệu', 'Quy chế công tác sinh viên',
      'Quy chế công tác sinh viên: quyền và nghĩa vụ của sinh viên, khen thưởng và kỷ luật sinh viên, công tác lớp, ban cán sự, và nhiệm vụ của cố vấn học tập. Cần chú ý Chương III và Phụ lục.',
      L.QCCTSV, 'công tác sinh viên quyền nghĩa vụ khen thưởng kỷ luật lớp trưởng ban cán sự nhiệm vụ cố vấn học tập'),
    row('HOCBONG', 'Quy định chính sách học bổng cho sinh viên đại học chính quy tại ĐHYD TP.HCM (số 2651)', 'Giới thiệu', 'Chính sách học bổng',
      'Quy định về các loại học bổng dành cho sinh viên đại học chính quy tại ĐHYD TP.HCM, điều kiện, tiêu chí xét chọn và mức học bổng. Cần chú ý Chương III.',
      L.HOCBONG, 'học bổng khuyến khích học tập điều kiện xét học bổng mức học bổng'),
    row('DRL', 'Quy chế đánh giá kết quả rèn luyện (số 5158)', 'Giới thiệu', 'Đánh giá kết quả rèn luyện',
      'Quy chế đánh giá kết quả rèn luyện của sinh viên: nội dung, tiêu chí, khung điểm, xếp loại rèn luyện, quy trình tự đánh giá và vai trò của lớp, cố vấn học tập, hội đồng các cấp. Cần chú ý Điều 14 và Điều 15. Sinh viên tự đánh giá theo mẫu Phiếu đánh giá kết quả rèn luyện (số 1706).',
      L.DRL, 'điểm rèn luyện đánh giá rèn luyện drl phiếu đánh giá xếp loại rèn luyện'),
    row('VPTHI', 'Quy định xử lý vi phạm quy chế thi (số 2971)', 'Giới thiệu', 'Xử lý vi phạm quy chế thi',
      'Quy định các hình thức xử lý khi sinh viên vi phạm quy chế thi, kiểm tra: các hành vi vi phạm và mức xử lý tương ứng.',
      L.VPTHI, 'vi phạm quy chế thi gian lận phao điện thoại đình chỉ thi khiển trách cảnh cáo'),
    row('CDRNN', 'Quy định về chuẩn đầu ra ngoại ngữ (số 792)', 'Giới thiệu', 'Chuẩn đầu ra ngoại ngữ',
      'Quy định chuẩn đầu ra ngoại ngữ đối với sinh viên: trình độ yêu cầu, các chứng chỉ được công nhận và thời điểm cần đạt. Tham khảo thêm Thông báo 5333 về nộp minh chứng năng lực tiếng Anh để xét chuẩn đầu ra.',
      L.CDRNN, 'chuẩn đầu ra ngoại ngữ tiếng anh chứng chỉ ielts toeic vstep b1 b2'),
    row('TBTA', 'Thông báo nộp minh chứng năng lực tiếng Anh xét chuẩn đầu ra (số 5333)', 'Giới thiệu', 'Nộp chứng chỉ tiếng Anh',
      'Thông báo về việc sinh viên nộp chứng chỉ, minh chứng năng lực tiếng Anh để xét chuẩn đầu ra ngoại ngữ (tài liệu tham khảo).',
      L.TBTA, 'nộp chứng chỉ tiếng anh minh chứng chuẩn đầu ra'),
    row('HOCPHI', 'Quyết định ban hành mức thu học phí NH 2026-2027 (số 3124/QĐ-ĐHYD)', 'Giới thiệu', 'Mức thu học phí',
      'Quyết định ban hành mức thu học phí năm học 2026-2027 của ĐHYD TP.HCM theo từng ngành, chương trình đào tạo.',
      L.HOCPHI, 'học phí mức thu học phí tín chỉ năm học 2026-2027'),
    row('TBHP', 'Thông báo về việc đóng học phí NH 2026-2027 (số 2383)', 'Giới thiệu', 'Đóng học phí',
      'Thông báo về việc đóng học phí năm học 2026-2027: thời hạn và cách thức đóng học phí.',
      L.TBHP, 'đóng học phí hạn đóng học phí thông báo nộp tiền'),
    row('HDHP', 'Hướng dẫn đóng học phí qua ứng dụng OneUni và trang sv.ump.edu.vn', 'Hướng dẫn', 'Cách đóng học phí',
      'Sinh viên đóng học phí qua ứng dụng di động OneUni hoặc trang sinh viên sv.ump.edu.vn để công nợ được cập nhật trực tiếp trên trang sinh viên. Có phim hướng dẫn tại link. Hướng dẫn nộp các khoản phí khác tại ĐHYD: ' + L.HDPHI,
      L.HDHP, 'đóng học phí oneuni chuyển khoản công nợ trang sinh viên nộp phí'),
    row('HOTRO', 'Quy định chế độ hỗ trợ sinh viên gặp khó khăn đột xuất (số 3767, ngày 27/10/2022)', 'Giới thiệu', 'Hỗ trợ khó khăn đột xuất',
      'Quy định chế độ hỗ trợ sinh viên gặp khó khăn đột xuất (ví dụ hoàn cảnh gia đình, tai nạn, bệnh tật, thiên tai). Sinh viên làm Đơn xin xét hỗ trợ khó khăn đột xuất theo mẫu.',
      L.HOTRO, 'hỗ trợ khó khăn đột xuất trợ cấp hoàn cảnh khó khăn tai nạn ốm đau'),
    row('THAMVAN', 'Phòng tham vấn tâm lý ĐHYD TP.HCM', 'Hướng dẫn', 'Tham vấn tâm lý',
      'Trường có Phòng tham vấn tâm lý hỗ trợ sinh viên khi gặp căng thẳng, áp lực học tập, khó khăn về cảm xúc, các mối quan hệ. Thông tin liên hệ và cách đặt lịch xem tại link.',
      L.THAMVAN, 'tham vấn tâm lý stress căng thẳng áp lực trầm cảm lo âu tư vấn tâm lý'),
    row('BIEUMAU', 'Hướng dẫn đề xuất các biểu mẫu trên trang sinh viên', 'Hướng dẫn', 'Đề xuất biểu mẫu trực tuyến',
      'Sinh viên đề xuất các biểu mẫu (giấy xác nhận sinh viên, các loại đơn) trực tuyến trên trang sinh viên sv.ump.edu.vn theo hướng dẫn tại link.',
      L.BIEUMAU, 'giấy xác nhận sinh viên đề xuất biểu mẫu trang sinh viên'),
    row('EPORT', 'Nộp E-portfolio', 'Hướng dẫn', 'Đăng tải E-portfolio',
      'Sinh viên đăng tải E-portfolio qua biểu mẫu trực tuyến tại link.',
      L.EPORT, 'e-portfolio eportfolio hồ sơ năng lực')
  ];
}
