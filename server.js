'use strict';
// Agenda de clases particulares — servidor sin dependencias (Node >= 18).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'agenda.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('base64url');
  console.warn(`\n[aviso] ADMIN_PASSWORD no está definida. Contraseña temporal para "${ADMIN_USER}": ${ADMIN_PASSWORD}\n`);
}
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 días

// ---------- Datos ----------
const DEFAULT_SETTINGS = {
  title: 'Clases particulares',
  slotMinutes: 60,
  // 0 = domingo … 6 = sábado
  days: {
    0: { enabled: false, start: '09:00', end: '13:00' },
    1: { enabled: true, start: '09:00', end: '21:00' },
    2: { enabled: true, start: '09:00', end: '21:00' },
    3: { enabled: true, start: '09:00', end: '21:00' },
    4: { enabled: true, start: '09:00', end: '21:00' },
    5: { enabled: true, start: '09:00', end: '21:00' },
    6: { enabled: true, start: '09:00', end: '13:00' },
  },
};

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      settings: { ...DEFAULT_SETTINGS, ...d.settings, days: { ...DEFAULT_SETTINGS.days, ...(d.settings && d.settings.days) } },
      bookings: Array.isArray(d.bookings) ? d.bookings : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('No se pudo leer', DATA_FILE, e.message);
    return { settings: structuredClone(DEFAULT_SETTINGS), bookings: [] };
  }
}
let db = loadData();

function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Utilidades de fechas ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseDate(s) {
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt : null;
}
const fmtDate = (dt) => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
function mondayOf(dt) { return addDays(dt, -((dt.getUTCDay() + 6) % 7)); }

function slotTimesFor(weekday) {
  const cfg = db.settings.days[weekday];
  if (!cfg || !cfg.enabled) return [];
  const out = [];
  const step = db.settings.slotMinutes;
  for (let m = toMin(cfg.start); m + step <= toMin(cfg.end); m += step) out.push(toTime(m));
  return out;
}

function buildWeek(startStr, isAdmin) {
  const start = mondayOf(parseDate(startStr) || new Date());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = addDays(start, i);
    const date = fmtDate(dt);
    const dayBookings = db.bookings.filter((b) => b.date === date);
    const times = new Set(slotTimesFor(dt.getUTCDay()));
    // En la vista admin también se muestran reservas fuera del horario configurado
    if (isAdmin) dayBookings.forEach((b) => times.add(b.time));
    const slots = [...times].sort().map((time) => {
      const b = dayBookings.find((x) => x.time === time);
      if (!b) return { time, status: 'free' };
      if (!isAdmin) return { time, status: 'busy' }; // nunca exponer nombres al público
      return { time, status: b.type === 'blocked' ? 'blocked' : 'booked', booking: b };
    });
    days.push({ date, weekday: dt.getUTCDay(), slots });
  }
  return { start: fmtDate(start), slotMinutes: db.settings.slotMinutes, title: db.settings.title, days };
}

// ---------- Sesiones ----------
const sessions = new Map(); // token -> expiración
const loginAttempts = new Map(); // ip -> { count, until }

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function isAuthed(req) {
  const t = getCookie(req, 'sid');
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function cookieFlags(req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

// ---------- HTTP ----------
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('json')); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Prohibido');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}

function validateSettings(s) {
  const slotMinutes = Number(s.slotMinutes);
  if (![15, 20, 30, 45, 60, 90, 120].includes(slotMinutes)) return 'Duración de clase inválida';
  const days = {};
  for (let i = 0; i < 7; i++) {
    const d = (s.days || {})[i] || {};
    if (!TIME_RE.test(d.start) || !TIME_RE.test(d.end)) return 'Horario inválido';
    if (d.enabled && toMin(d.end) <= toMin(d.start)) return 'La hora de fin debe ser posterior a la de inicio';
    days[i] = { enabled: !!d.enabled, start: d.start, end: d.end };
  }
  const title = String(s.title || '').trim().slice(0, 80) || DEFAULT_SETTINGS.title;
  return { title, slotMinutes, days };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/public/week' && m === 'GET') return send(res, 200, buildWeek(url.searchParams.get('start'), false));

  if (p === '/api/login' && m === 'POST') {
    const ip = req.socket.remoteAddress;
    const a = loginAttempts.get(ip);
    if (a && a.until > Date.now()) return send(res, 429, { error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
    const { user, password } = await readBody(req);
    if (safeEqual(user, ADMIN_USER) && safeEqual(password, ADMIN_PASSWORD)) {
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${token}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieFlags(req)}` });
    }
    const count = (a ? a.count : 0) + 1;
    loginAttempts.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60000 : 0 });
    return send(res, 401, { error: 'Usuario o contraseña incorrectos' });
  }
  if (p === '/api/logout' && m === 'POST') {
    const t = getCookie(req, 'sid'); if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=; Max-Age=0; ${cookieFlags(req)}` });
  }
  if (p === '/api/session' && m === 'GET') return send(res, 200, { authed: isAuthed(req) });

  // ---- Rutas protegidas ----
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'No encontrado' });
  if (!isAuthed(req)) return send(res, 401, { error: 'No autorizado' });

  if (p === '/api/admin/week' && m === 'GET') return send(res, 200, buildWeek(url.searchParams.get('start'), true));

  if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, db.settings);
  if (p === '/api/admin/settings' && m === 'PUT') {
    const r = validateSettings(await readBody(req));
    if (typeof r === 'string') return send(res, 400, { error: r });
    db.settings = r; saveData();
    return send(res, 200, db.settings);
  }

  if (p === '/api/admin/bookings' && m === 'POST') {
    const b = await readBody(req);
    const type = b.type === 'blocked' ? 'blocked' : 'booking';
    const name = String(b.name || '').trim().slice(0, 100);
    const note = String(b.note || '').trim().slice(0, 300);
    const weeks = Math.min(Math.max(parseInt(b.repeatWeeks, 10) || 1, 1), 52);
    const start = parseDate(b.date);
    if (!start || !TIME_RE.test(b.time)) return send(res, 400, { error: 'Fecha u hora inválida' });
    if (type === 'booking' && !name) return send(res, 400, { error: 'Ingresá el nombre del alumno' });
    const created = [], skipped = [];
    const group = weeks > 1 ? crypto.randomUUID() : undefined;
    for (let i = 0; i < weeks; i++) {
      const date = fmtDate(addDays(start, i * 7));
      if (db.bookings.some((x) => x.date === date && x.time === b.time)) { skipped.push(date); continue; }
      const nb = { id: crypto.randomUUID(), date, time: b.time, type, name: type === 'booking' ? name : '', note, group, createdAt: new Date().toISOString() };
      db.bookings.push(nb); created.push(nb);
    }
    if (!created.length) return send(res, 409, { error: 'Ese horario ya está ocupado' });
    saveData();
    return send(res, 201, { created, skipped });
  }

  const mm = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/);
  if (mm) {
    const idx = db.bookings.findIndex((x) => x.id === mm[1]);
    if (idx === -1) return send(res, 404, { error: 'Reserva no encontrada' });
    if (m === 'PUT') {
      const b = await readBody(req);
      const cur = db.bookings[idx];
      const type = b.type === 'blocked' ? 'blocked' : 'booking';
      const name = String(b.name || '').trim().slice(0, 100);
      if (type === 'booking' && !name) return send(res, 400, { error: 'Ingresá el nombre del alumno' });
      Object.assign(cur, { type, name: type === 'booking' ? name : '', note: String(b.note || '').trim().slice(0, 300) });
      saveData();
      return send(res, 200, cur);
    }
    if (m === 'DELETE') {
      const cur = db.bookings[idx];
      if (url.searchParams.get('series') === '1' && cur.group) {
        db.bookings = db.bookings.filter((x) => !(x.group === cur.group && x.date >= cur.date));
      } else db.bookings.splice(idx, 1);
      saveData();
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'No encontrado' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return send(res, 403, { error: 'Origen no permitido' });
      }
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: 'Solicitud inválida' });
  }
});

server.listen(PORT, () => console.log(`Agenda en http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`));
