/**
 * Tìm trích đoạn liên quan trong kho kiến thức (BM25 trên âm tiết và cặp âm tiết tiếng Việt).
 * Không cần dịch vụ ngoài, chạy ngay trong Worker.
 */

/** Bỏ dấu, chữ thường, chỉ giữ chữ và số. */
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Âm tiết quá phổ biến, không giúp phân biệt nội dung
const STOP = new Set(
  ('va cua cac la cho duoc trong nhung co khong theo voi mot nay tai den tu khi thi de ve do ' +
    'em minh toi a oi gi nao sao the vay ha nhe a o ra vao lai nay ay cung con hay hoac neu ' +
    'nhu thi bi da dang se muon can phai lam xin hoi cho biet giup ban thay co').split(' ')
);

// Từ viết tắt / cách nói thường gặp của sinh viên → cụm từ trong văn bản
const SYNONYMS = {
  cvht: 'co van hoc tap',
  drl: 'ren luyen diem ren luyen',
  sv: 'sinh vien',
  gv: 'giang vien',
  gpa: 'diem trung binh tich luy',
  dtb: 'diem trung binh',
  tbc: 'diem trung binh',
  ielts: 'ngoai ngu tieng anh chung chi',
  toeic: 'ngoai ngu tieng anh chung chi',
  toefl: 'ngoai ngu tieng anh chung chi',
  vstep: 'ngoai ngu tieng anh chung chi',
  cdr: 'chuan dau ra',
  hb: 'hoc bong',
  kkht: 'khuyen khich hoc tap',
  hp: 'hoc phan hoc phi',
  tc: 'tin chi',
  bl: 'bao luu',
  kl: 'ky luat',
  eportfolio: 'e portfolio',
  rot: 'khong dat hoc lai thi lai',
  tach: 'khong dat',
  stress: 'tham van tam ly cang thang',
  'tram cam': 'tham van tam ly',
  'ap luc': 'tham van tam ly cang thang',
  'buon': 'tham van tam ly',
  'bao luu': 'nghi hoc tam thoi',
  'nghi hoc': 'nghi hoc tam thoi',
  'tien hoc': 'hoc phi',
  'dong tien': 'dong hoc phi',
  'mat the': 'cap lai the sinh vien',
  'the sinh vien': 'cap lai the sinh vien',
  'phuc tra': 'phuc khao',
  'cham lai': 'phuc khao',
  'thi lai': 'hoc lai thi lai',
  'canh cao': 'canh bao hoc tap ky luat',
  'bo hoc': 'thoi hoc',
  'tro cap': 'ho tro kho khan dot xuat',
  'kho khan': 'ho tro kho khan dot xuat',
  'gian lan': 'vi pham quy che thi',
  'phao': 'vi pham quy che thi',
  'lich thi': 'ke hoach dao tao lich thi',
  'lich hoc': 'ke hoach dao tao',
  'nghi tet': 'ke hoach dao tao nghi tet',
  'nghi he': 'ke hoach dao tao nghi he',
};

function expand(text) {
  let t = ' ' + norm(text) + ' ';
  const extra = [];
  for (const [k, v] of Object.entries(SYNONYMS)) {
    if (t.includes(' ' + k + ' ')) extra.push(v);
  }
  return (t + ' ' + extra.join(' ')).trim();
}

/** Âm tiết đơn (bỏ từ dừng) + cặp âm tiết liên tiếp (giữ nghĩa từ ghép: "hoc phi", "ren luyen"). */
export function terms(text, { expandSyn = false } = {}) {
  const syl = (expandSyn ? expand(text) : norm(text)).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < syl.length; i++) {
    const a = syl[i];
    if (!STOP.has(a) && (a.length > 1 || /\d/.test(a))) out.push(a);
    if (i + 1 < syl.length) {
      const b = syl[i + 1];
      if (!(STOP.has(a) && STOP.has(b))) out.push(a + '_' + b);
    }
  }
  return out;
}

function tf(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

/**
 * chunks: [{doc, code, muc, title, text, link, kw, isDoc}]
 * Tiêu đề, tên văn bản, từ khóa được nhân trọng số để khớp tốt hơn.
 */
export function buildIndex(chunks) {
  const docs = [];
  const df = new Map();
  let total = 0;
  for (const c of chunks) {
    const head = [c.doc, c.muc, c.title].join(' ');
    const words = [
      ...terms(head), ...terms(head), ...terms(head),
      ...terms(c.kw), ...terms(c.kw),
      ...terms(c.text),
    ];
    const f = tf(words);
    for (const t of f.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ chunk: c, tf: f, len: words.length });
    total += words.length;
  }
  return { docs, df, N: docs.length, avg: docs.length ? total / docs.length : 1 };
}

function scoreQuery(index, qTerms, weight, scores) {
  const { docs, df, N, avg } = index;
  const k1 = 1.2;
  const b = 0.75;
  const q = tf(qTerms);
  for (const [t, qn] of q) {
    const n = df.get(t);
    if (!n) continue;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const boost = (t.includes('_') ? 1.6 : 1) * weight * Math.min(qn, 2);
    for (let i = 0; i < docs.length; i++) {
      const f = docs[i].tf.get(t);
      if (!f) continue;
      const s = idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].len) / avg)));
      scores[i] = (scores[i] || 0) + s * boost;
    }
  }
}

/** Trả về các trích đoạn liên quan nhất, tổng độ dài ≤ maxChars. */
export function search(index, query, { previous = '', limit = 6, maxChars = 9000 } = {}) {
  if (!index || !index.N) return [];
  const scores = new Array(index.N).fill(0);
  const qTerms = terms(query, { expandSyn: true });
  scoreQuery(index, qTerms, 1, scores);
  // Câu hỏi nối tiếp ngắn: dùng thêm câu hỏi trước với trọng số thấp
  if (previous && norm(query).split(' ').length < 8) scoreQuery(index, terms(previous, { expandSyn: true }), 0.5, scores);

  const ranked = scores
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return [];
  const top = ranked[0].s;
  const out = [];
  let used = 0;
  let docCount = 0;
  for (const { s, i } of ranked) {
    if (out.length >= limit) break;
    if (s < top * 0.25) break; // bỏ kết quả quá yếu so với kết quả tốt nhất
    const c = index.docs[i].chunk;
    if (c.isDoc && docCount >= 3) continue; // tối đa 3 mẫu đơn/tài liệu
    let text = String(c.text || '');
    const room = maxChars - used;
    if (room < 300) break;
    if (text.length > Math.min(room, 3200)) text = text.slice(0, Math.min(room, 3200)) + ' …';
    used += text.length;
    if (c.isDoc) docCount++;
    out.push({ ...c, text, score: Math.round(s * 100) / 100 });
  }
  return out;
}
