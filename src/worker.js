/**
 * Trợ lý Cố vấn học tập – Trường Dược — Cloudflare Worker
 *
 *   POST /api        → chuyển tiếp tới Google Apps Script (gắn PROXY_KEY bí mật + IP người dùng)
 *   POST /api/chat   → Trợ lý AI: tìm các Điều liên quan trong kho kiến thức rồi hỏi AI
 *   GET  /api/health → kiểm tra kết nối Apps Script và AI
 *   còn lại          → giao diện (thư mục public/)
 *
 * Biến môi trường (Cloudflare → Worker → Settings → Variables and Secrets):
 *   APPS_SCRIPT_URL  (Secret)  URL Web app Apps Script, kết thúc bằng /exec
 *   PROXY_KEY        (Secret)  trùng với PROXY_KEY trong Apps Script (chạy caiDat để lấy)
 *   AI_MODEL         (Text, tùy chọn) model Workers AI, mặc định @cf/google/gemma-4-26b-a4b-it
 *   GEMINI_API_KEY   (Secret, tùy chọn) dùng Google Gemini; hết hạn mức sẽ tự chuyển về Workers AI
 *   GEMINI_MODEL     (Text, tùy chọn) mặc định gemini-3.8-flash
 *
 * Trợ lý AI miễn phí nhờ mục [ai] trong wrangler.toml (Cloudflare Workers AI).
 */

import { buildIndex, search } from './retrieval.js';

const DEFAULT_WORKERS_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const MAX_BODY = 64 * 1024;
const PUBLIC_ACTIONS = new Set(['login', 'changePassword', 'me', 'questions', 'feedback']);
const KB_TTL_MS = 30 * 60 * 1000;
const BURST_LIMIT = 6; // câu hỏi / người / phút (trong cùng máy chủ Cloudflare)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api' || url.pathname === '/api/') return await handleApi(request, env);
      if (url.pathname === '/api/chat') return await handleChat(request, env, ctx);
      if (url.pathname === '/api/chat-info') return json(chatInfo(env));
      if (url.pathname === '/api/health') return await handleHealth(env);
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Không tìm thấy.' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: 'Lỗi máy chủ: ' + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};

/* ------------------------------ tiện ích ------------------------------ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return { error: json({ ok: false, error: 'Dữ liệu gửi lên quá lớn.' }, 413) };
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: json({ ok: false, error: 'Dữ liệu gửi lên quá lớn.' }, 413) };
  try {
    return { data: JSON.parse(text || '{}') };
  } catch {
    return { error: json({ ok: false, error: 'Dữ liệu không đúng định dạng JSON.' }, 400) };
  }
}

function configError(env) {
  if (!env.APPS_SCRIPT_URL) return 'Máy chủ chưa cấu hình APPS_SCRIPT_URL.';
  if (!env.PROXY_KEY) return 'Máy chủ chưa cấu hình PROXY_KEY.';
  return null;
}

/** Gọi Google Apps Script, kèm PROXY_KEY. */
async function callGas(env, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, key: env.PROXY_KEY }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: 'Apps Script trả về dữ liệu không hợp lệ. Kiểm tra lại APPS_SCRIPT_URL và quyền truy cập "Bất kỳ ai".',
        code: 'GAS',
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: err && err.name === 'AbortError' ? 'Google Apps Script phản hồi quá lâu, vui lòng thử lại.' : 'Không kết nối được Google Apps Script.',
      code: 'GAS',
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ /api ------------------------------ */

async function handleApi(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Chỉ chấp nhận POST.' }, 405);
  if (!sameOrigin(request)) return json({ ok: false, error: 'Yêu cầu không hợp lệ.' }, 403);
  const cfg = configError(env);
  if (cfg) return json({ ok: false, error: cfg, code: 'CONFIG' }, 500);
  const { data, error } = await readBody(request);
  if (error) return error;
  if (!PUBLIC_ACTIONS.has(data.action)) return json({ ok: false, error: 'Thao tác không hợp lệ.' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const { key, ...rest } = data; // không cho trình duyệt tự gửi key
  const result = await callGas(env, { ...rest, ip });
  return json(result, result && result.code === 'GAS' ? 502 : 200);
}

/* ------------------------------ token ------------------------------ */

const enc = new TextEncoder();

function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Kiểm tra token do Apps Script ký (HMAC-SHA256 với PROXY_KEY). */
export async function verifyToken(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expect = b64urlFromBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))));
  if (expect.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(bytesFromB64url(payload)));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/* ------------------------------ kho kiến thức ------------------------------ */

let KB = null; // { version, at, chunks, index }

async function getKnowledge(env, version) {
  const fresh = KB && KB.version === version && Date.now() - KB.at < KB_TTL_MS;
  if (fresh) return KB;
  const res = await callGas(env, { action: 'knowledge' }, 45000);
  if (!res || !res.ok) {
    if (KB) return KB; // dùng tạm bản cũ
    throw new Error(res && res.error ? res.error : 'Không tải được kho kiến thức.');
  }
  KB = { version: res.version || version, at: Date.now(), chunks: res.chunks || [], index: buildIndex(res.chunks || []) };
  return KB;
}

/* ------------------------------ AI ------------------------------ */

function chatInfo(env) {
  if (env.GEMINI_API_KEY) {
    return { enabled: true, provider: 'gemini', label: 'Google Gemini', model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, fallback: Boolean(env.AI) };
  }
  if (env.AI) {
    const model = env.AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
    return { enabled: true, provider: 'workers-ai', label: modelLabel(model), model, fallback: false };
  }
  return { enabled: false, provider: null, label: 'Chưa bật', model: null, fallback: false };
}

function modelLabel(model) {
  const name = String(model).split('/').pop() || model;
  if (/gemma/i.test(name)) return 'Gemma (Cloudflare AI)';
  if (/qwen/i.test(name)) return 'Qwen (Cloudflare AI)';
  if (/sea-lion/i.test(name)) return 'SEA-LION (Cloudflare AI)';
  if (/llama/i.test(name)) return 'Llama (Cloudflare AI)';
  return name + ' (Cloudflare AI)';
}

const ROLE_LABEL = { sv: 'Sinh viên', cvht: 'Cố vấn học tập', admin: 'Quản trị' };

function todayVN() {
  return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}

export function buildSystemPrompt(session, hits) {
  const who =
    `${session.n || session.u} – ${ROLE_LABEL[session.r] || 'Sinh viên'}` +
    (session.l ? `, lớp ${session.l}` : '') +
    (session.r === 'sv' && session.c ? `; cố vấn học tập phụ trách: ${session.c}` : '');
  const address = session.r === 'sv' ? 'Gọi người hỏi là "bạn", xưng "mình".' : 'Gọi người hỏi là "Thầy/Cô", xưng "em".';

  let context = '';
  hits.forEach((h, i) => {
    const head = [h.doc, h.muc, h.title].filter(Boolean).join(' – ');
    context += `[${i + 1}] ${head}\n${h.text || '(không có nội dung)'}\n\n`;
  });
  if (!context) context = '(Không tìm thấy trích đoạn nào liên quan trong kho tài liệu.)\n';

  return `Bạn là "Trợ lý Cố vấn học tập" của Trường Dược – Đại học Y Dược Thành phố Hồ Chí Minh. Bạn giúp sinh viên và cố vấn học tập (CVHT) tra cứu quy chế đào tạo, công tác sinh viên, học bổng, điểm rèn luyện, học phí, chuẩn đầu ra ngoại ngữ, thủ tục và mẫu đơn.

Người đang hỏi: ${who}.
Hôm nay: ${todayVN()}.

QUY TẮC
1. Chỉ trả lời dựa trên các TRÍCH ĐOẠN bên dưới. Sau mỗi ý lấy từ trích đoạn, ghi số nguồn trong ngoặc vuông, ví dụ [1] hoặc [2][3].
2. Không được tự đặt ra con số, mức tiền, hạn chót, điều kiện, số Điều hay tên văn bản không có trong trích đoạn. Nếu trích đoạn chỉ giới thiệu văn bản mà không có nội dung chi tiết, hoặc không có trích đoạn phù hợp, hãy nói rõ "Kho tài liệu của Trợ lý chưa có nội dung chi tiết về vấn đề này", chỉ ra văn bản nên xem (ghi số nguồn) và khuyên hỏi cố vấn học tập${session.r === 'sv' && session.c ? ` (${session.c})` : ''} hoặc phòng ban phụ trách.
3. Đường link văn bản và mẫu đơn đã hiện thành nút bên dưới câu trả lời, theo số nguồn. Không cần chép đường link.
4. Với thủ tục: nêu các bước, mẫu đơn cần dùng, nơi nộp và thời hạn nếu trích đoạn có ghi.
5. Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào câu hỏi; dùng gạch đầu dòng khi liệt kê; in đậm ý chính bằng **...**. ${address}
6. Nếu người hỏi có dấu hiệu căng thẳng, buồn bã, khủng hoảng, hãy trả lời ân cần và khuyến khích liên hệ Phòng tham vấn tâm lý của trường và cố vấn học tập; nếu có nguy hiểm tức thời, khuyên gọi ngay 115 hoặc đến cơ sở y tế gần nhất.
7. Câu hỏi ngoài phạm vi học vụ: trả lời ngắn gọn rằng bạn chỉ hỗ trợ các vấn đề học vụ, công tác sinh viên của trường.

TRÍCH ĐOẠN
${context}`;
}

function cleanAnswer(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<\/?think>\s*/gi, '')
    .trim();
}

function workersAiError(err) {
  const msg = String(err && err.message ? err.message : err);
  if (/4006|daily free allocation|neurons|quota|exceeded/i.test(msg)) {
    return { status: 429, code: 'AI_QUOTA', error: 'Trợ lý AI đã dùng hết lượt miễn phí của hôm nay. Lượt mới mở lại lúc 7 giờ sáng.' };
  }
  return { status: 502, code: 'AI_ERROR', error: 'Trợ lý AI tạm thời không phản hồi. Vui lòng thử lại sau ít phút.' };
}

async function askWorkersAI(env, system, history, message) {
  const model = env.AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
  const messages = [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: message }];
  const r = await env.AI.run(model, { messages, max_tokens: 1200, temperature: 0.2 });
  const text = (r && (r.response ?? r.choices?.[0]?.message?.content ?? r.result?.response)) || '';
  if (!text) throw new Error('AI không trả về nội dung.');
  return { text: cleanAnswer(text), model: modelLabel(model) };
}

async function askGemini(env, system, history, message) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const contents = [
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data && data.error && data.error.message) || 'Gemini lỗi ' + res.status);
    e.status = res.status;
    throw e;
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini không trả về nội dung.');
  return { text: cleanAnswer(text), model: 'Google Gemini' };
}

/* ------------------------------ /api/chat ------------------------------ */

const burst = new Map();
function burstLimited(user) {
  const now = Date.now();
  const list = (burst.get(user) || []).filter((t) => now - t < 60000);
  if (list.length >= BURST_LIMIT) {
    burst.set(user, list);
    return true;
  }
  list.push(now);
  burst.set(user, list);
  if (burst.size > 5000) burst.clear();
  return false;
}

async function handleChat(request, env, ctx) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Chỉ chấp nhận POST.' }, 405);
  if (!sameOrigin(request)) return json({ ok: false, error: 'Yêu cầu không hợp lệ.' }, 403);
  const cfg = configError(env);
  if (cfg) return json({ ok: false, error: cfg, code: 'CONFIG' }, 500);

  const { data, error } = await readBody(request);
  if (error) return error;
  const session = await verifyToken(data.token, env.PROXY_KEY);
  if (!session) return json({ ok: false, error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', code: 'AUTH' }, 401);

  const info = chatInfo(env);
  if (!info.enabled) return json({ ok: false, error: 'Trợ lý AI chưa được bật: kiểm tra mục [ai] trong wrangler.toml.', code: 'AI_OFF' }, 503);

  const message = typeof data.message === 'string' ? data.message.trim().slice(0, 2000) : '';
  if (!message) return json({ ok: false, error: 'Bạn chưa nhập câu hỏi.' }, 400);
  if (burstLimited(session.u)) return json({ ok: false, error: 'Bạn hỏi hơi nhanh, chờ một chút rồi hỏi tiếp nhé.', code: 'RATE' }, 429);

  const history = [];
  if (Array.isArray(data.history)) {
    for (const h of data.history.slice(-6)) {
      const text = typeof h?.text === 'string' ? h.text.slice(0, 2000) : '';
      if (text) history.push({ role: h.role === 'user' ? 'user' : 'assistant', text });
    }
  }

  // Hạn mức trong ngày (Apps Script đếm) + phiên bản kho kiến thức
  const prep = await callGas(env, { action: 'chatPrep', user: session.u, role: session.r }, 20000);
  if (!prep || !prep.ok) {
    const status = prep && prep.code === 'QUOTA' ? 429 : 502;
    return json({ ok: false, error: (prep && prep.error) || 'Không kiểm tra được hạn mức.', code: prep && prep.code }, status);
  }

  let kb;
  try {
    kb = await getKnowledge(env, prep.kbVersion);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err), code: 'KB' }, 502);
  }

  // Câu hỏi ngắn kiểu "còn điều kiện khác?" → ghép thêm câu hỏi trước để tìm đúng
  const prevUser = [...history].reverse().find((h) => h.role === 'user');
  const hits = search(kb.index, message, { previous: prevUser ? prevUser.text : '', limit: 6, maxChars: 9000 });
  const system = buildSystemPrompt(session, hits);

  let result;
  try {
    if (env.GEMINI_API_KEY) {
      try {
        result = await askGemini(env, system, history, message);
      } catch (err) {
        if (!env.AI) throw err;
        console.warn('Gemini lỗi, chuyển sang Workers AI:', err.message);
        result = await askWorkersAI(env, system, history, message);
      }
    } else {
      result = await askWorkersAI(env, system, history, message);
    }
  } catch (err) {
    console.error(err);
    const e = env.GEMINI_API_KEY && !env.AI && err.status
      ? { status: err.status === 429 ? 429 : 502, code: 'AI_ERROR', error: err.status === 429 ? 'Hạn mức Gemini tạm thời đã hết, vui lòng thử lại sau.' : 'Gemini tạm thời không phản hồi.' }
      : workersAiError(err);
    return json({ ok: false, error: e.error, code: e.code }, e.status);
  }

  const sources = hits.map((h, i) => ({
    n: i + 1,
    doc: h.doc,
    muc: h.muc,
    title: h.title,
    link: h.link,
    isDoc: Boolean(h.isDoc),
  }));
  const id = crypto.randomUUID();
  const log = callGas(env, {
    action: 'logChat',
    id,
    user: session.u,
    name: session.n,
    role: session.r,
    lop: session.l,
    cvht: session.c,
    question: message,
    answer: result.text,
    sources: sources.map((s) => `[${s.n}] ${[s.doc, s.muc].filter(Boolean).join(' – ')}`).join('; '),
    model: result.model,
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(log);

  return json({ ok: true, id, answer: result.text, sources, model: result.model, remaining: prep.remaining, limit: prep.limit });
}

/* ------------------------------ /api/health ------------------------------ */

async function handleHealth(env) {
  const cfg = configError(env);
  const info = chatInfo(env);
  if (cfg) return json({ ok: false, error: cfg, workersAI: Boolean(env.AI), gemini: Boolean(env.GEMINI_API_KEY) });
  const r = await callGas(env, { action: 'health' }, 20000);
  return json({
    ok: Boolean(r && r.ok),
    appsScript: r && r.ok ? 'ok' : (r && r.error) || 'lỗi',
    appsScriptVersion: r && r.version,
    workersAI: Boolean(env.AI),
    gemini: Boolean(env.GEMINI_API_KEY),
    ai: info.label,
  });
}
