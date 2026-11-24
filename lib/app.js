'use strict';
// Lógica de la agenda: API HTTP independiente del servidor (local o Vercel).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ON_VERCEL = !!process.env.VERCEL;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD && !ON_VERCEL) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('base64url');
  console.warn(`\n[aviso] ADMIN_PASSWORD no está definida. Contraseña temporal para "${ADMIN_USER}": ${ADMIN_PASSWORD}\n`);
}
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(`agenda:${ADMIN_USER}:${ADMIN_PASSWORD}`).digest('hex');
const SESSION_TTL_S = 60 * 60 * 24 * 7; // 7 días

// ---------- Almacenamiento ----------
// En Vercel se usa Redis (Upstash). En local, un archivo JSON.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const REDIS_KEY = 'agenda:data';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'agenda.json');

class ConfigError extends Error {}

async function redis(...cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

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

function normalize(d) {
  d = d || {};
  return {
    settings: { ...DEFAULT_SETTINGS, ...d.settings, days: { ...DEFAULT_SETTINGS.days, ...(d.settings && d.settings.days) } },
    bookings: Array.isArray(d.bookings) ? d.bookings : [],
  };
}

async function loadData() {
  if (REDIS_URL) {
    const raw = await redis('GET', REDIS_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  }
  if (ON_VERCEL) throw new ConfigError('Falta conectar la base de datos (Upstash Redis) en Vercel.');
  try {
    return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('No se pudo leer', DATA_FILE, e.message);
    return normalize(null);
  }
}

async function saveData(db) {
  if (REDIS_URL) return redis('SET', REDIS_KEY, JSON.stringify(db));
  if (ON_VERCEL) throw new ConfigError('Falta conectar la base de datos (Upstash Redis) en Vercel.');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Fechas ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseDate(s) {
  if (!DATE_RE.test(s || '')) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt : null;
}
const fmtDate = (dt) => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const mondayOf = (dt) => addDays(dt, -((dt.getUTCDay() + 6) % 7));

function slotTimesFor(settings, weekday) {
  const cfg = settings.days[weekday];
  if (!cfg || !cfg.enabled) return [];
  const out = [];
  const step = settings.slotMinutes;
  for (let m = toMin(cfg.start); m + step <= toMin(cfg.end); m += step) out.push(toTime(m));
  return out;
}

function buildWeek(db, startStr, isAdmin) {
  const start = mondayOf(parseDate(startStr) || new Date());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = addDays(start, i);
    const date = fmtDate(dt);
    const dayBookings = db.bookings.filter((b) => b.date === date);
    const times = new Set(slotTimesFor(db.settings, dt.getUTCDay()));
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

// ---------- Sesión (cookie firmada, sin estado en el servidor) ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function makeToken() {
  const payload = `${Math.floor(Date.now() / 1000) + SESSION_TTL_S}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}
function isAuthed(req) {
  const t = getCookie(req, 'sid');
  if (!t || !ADMIN_PASSWORD) return false;
  const i = t.lastIndexOf('.');
  const payload = t.slice(0, i);
  if (i < 0 || !safeEqual(sign(payload), t.slice(i + 1))) return false;
  return Number(payload.split('.')[0]) > Date.now() / 1000;
}
function cookieFlags(req) {
  const secure = ON_VERCEL || req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// Límite de intentos de login: en Redis si está disponible, si no en memoria.
const memAttempts = new Map();
async function loginBlocked(ip) {
  if (REDIS_URL) return Number(await redis('GET', `agenda:login:${ip}`)) >= 5;
  const a = memAttempts.get(ip);
  return !!a && a.count >= 5 && a.until > Date.now();
}
async function loginFailed(ip) {
  if (REDIS_URL) {
    const n = await redis('INCR', `agenda:login:${ip}`);
    if (n === 1) await redis('EXPIRE', `agenda:login:${ip}`, 300);
    return;
  }
  const a = memAttempts.get(ip);
  const fresh = !a || a.until < Date.now();
  memAttempts.set(ip, { count: fresh ? 1 : a.count + 1, until: Date.now() + 300000 });
}
async function loginOk(ip) {
  if (REDIS_URL) await redis('DEL', `agenda:login:${ip}`); else memAttempts.delete(ip);
}

// ---------- HTTP ----------
function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  // En Vercel el cuerpo puede venir ya leído en req.body
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return Promise.resolve(req.body ? JSON.parse(req.body) : {});
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.length ? JSON.parse(req.body) : {});
    return Promise.resolve(req.body || {});
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('json')); } });
    req.on('error', reject);
  });
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/public/week' && m === 'GET') {
    return send(res, 200, buildWeek(await loadData(), url.searchParams.get('start'), false));
  }

  if (p === '/api/login' && m === 'POST') {
    if (!ADMIN_PASSWORD) return send(res, 500, { error: 'Falta configurar ADMIN_PASSWORD en el servidor.' });
    const ip = clientIp(req);
    if (await loginBlocked(ip)) return send(res, 429, { error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
    const { user, password } = await readBody(req);
    if (safeEqual(user, ADMIN_USER) && safeEqual(password, ADMIN_PASSWORD)) {
      await loginOk(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${makeToken()}; Max-Age=${SESSION_TTL_S}; ${cookieFlags(req)}` });
    }
    await loginFailed(ip);
    return send(res, 401, { error: 'Usuario o contraseña incorrectos' });
  }
  if (p === '/api/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=; Max-Age=0; ${cookieFlags(req)}` });
  }
  if (p === '/api/session' && m === 'GET') return send(res, 200, { authed: isAuthed(req) });

  // ---- Rutas protegidas ----
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'No encontrado' });
  if (!isAuthed(req)) return send(res, 401, { error: 'No autorizado' });

  const db = await loadData();

  if (p === '/api/admin/week' && m === 'GET') return send(res, 200, buildWeek(db, url.searchParams.get('start'), true));

  if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, db.settings);
  if (p === '/api/admin/settings' && m === 'PUT') {
    const r = validateSettings(await readBody(req));
    if (typeof r === 'string') return send(res, 400, { error: r });
    db.settings = r; await saveData(db);
    return send(res, 200, db.settings);
  }

  if (p === '/api/admin/bookings' && m === 'POST') {
    const b = await readBody(req);
    const type = b.type === 'blocked' ? 'blocked' : 'booking';
    const name = String(b.name || '').trim().slice(0, 100);
    const note = String(b.note || '').trim().slice(0, 300);
    const weeks = Math.min(Math.max(parseInt(b.repeatWeeks, 10) || 1, 1), 52);
    const start = parseDate(b.date);
    if (!start || !TIME_RE.test(b.time || '')) return send(res, 400, { error: 'Fecha u hora inválida' });
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
    await saveData(db);
    return send(res, 201, { created, skipped });
  }

  const mm = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/);
  if (mm) {
    const idx = db.bookings.findIndex((x) => x.id === mm[1]);
    if (idx === -1) return send(res, 404, { error: 'Reserva no encontrada' });
    const cur = db.bookings[idx];
    if (m === 'PUT') {
      const b = await readBody(req);
      const type = b.type === 'blocked' ? 'blocked' : 'booking';
      const name = String(b.name || '').trim().slice(0, 100);
      if (type === 'booking' && !name) return send(res, 400, { error: 'Ingresá el nombre del alumno' });
      Object.assign(cur, { type, name: type === 'booking' ? name : '', note: String(b.note || '').trim().slice(0, 300) });
      await saveData(db);
      return send(res, 200, cur);
    }
    if (m === 'DELETE') {
      if (url.searchParams.get('series') === '1' && cur.group) {
        db.bookings = db.bookings.filter((x) => !(x.group === cur.group && x.date >= cur.date));
      } else db.bookings.splice(idx, 1);
      await saveData(db);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'No encontrado' });
}

/** Manejador de /api/*. Sirve tanto para el servidor local como para Vercel. */
async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // En Vercel, vercel.json reescribe /api/<ruta> a /api/index?path=<ruta>
  const rewritten = url.searchParams.get('__path');
  if (rewritten !== null) { url.pathname = '/api/' + rewritten; url.searchParams.delete('__path'); }
  try {
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      return send(res, 403, { error: 'Origen no permitido' });
    }
    return await route(req, res, url);
  } catch (e) {
    if (e instanceof ConfigError) return send(res, 500, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, e.message.startsWith('Redis') ? 500 : 400, { error: e.message.startsWith('Redis') ? 'Error de base de datos' : 'Solicitud inválida' });
  }
}

module.exports = { handleApi };
