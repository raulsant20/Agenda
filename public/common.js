// Utilidades compartidas entre la vista pública y la de administración.
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function mondayOf(d) { const r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); return r; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function shortDate(s) { const d = parseYmd(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; }
function rangeLabel(start) {
  const s = parseYmd(start), e = addDays(s, 6);
  return s.getMonth() === e.getMonth()
    ? `${s.getDate()}–${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`
    : `${s.getDate()} ${MONTHS[s.getMonth()]} – ${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
}
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
function isPastSlot(date, time) {
  const [h, m] = time.split(':').map(Number);
  const d = parseYmd(date); d.setHours(h, m);
  return d < new Date();
}

/**
 * Dibuja la semana.
 * opts.slotContent(slot, day) -> { cls, label, sub, clickable }
 * opts.onSlot(slot, day)
 * opts.hidePast: oculta horarios ya pasados
 */
function renderWeek(container, week, opts) {
  const today = ymd(new Date());
  container.replaceChildren(...week.days.map((day) => {
    const isPastDay = day.date < today;
    const visible = day.slots.filter((s) => !(opts.hidePast && isPastSlot(day.date, s.time)));
    const free = day.slots.filter((s) => s.status === 'free' && !isPastSlot(day.date, s.time)).length;
    const slots = visible.map((s) => {
      const c = opts.slotContent(s, day);
      const past = isPastSlot(day.date, s.time);
      const cls = `slot ${c.cls}${past ? ' past' : ''}`;
      const inner = [el('span', { class: 't' }, s.time), c.sub ? el('span', { class: 'n' }, c.sub) : null];
      return c.clickable
        ? el('button', { class: cls, type: 'button', title: c.label, onclick: () => opts.onSlot(s, day) }, inner)
        : el('div', { class: cls, title: c.label }, inner);
    });
    return el('section', { class: `day${day.date === today ? ' today' : ''}${isPastDay ? ' past' : ''}` },
      el('h2', {}, DAY_NAMES[day.weekday], el('small', {}, shortDate(day.date))),
      slots.length && !isPastDay ? el('div', { class: 'count' }, free === 1 ? '1 hora libre' : `${free} horas libres`) : null,
      slots.length ? el('div', { class: 'slots' }, slots)
        : el('div', { class: 'empty' }, isPastDay ? '—' : day.slots.length ? 'No quedan horas hoy' : 'Sin clases'));
  }));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Error'); e.status = res.status; throw e; }
  return data;
}

/** Navegación semanal con la semana en la URL (?semana=YYYY-MM-DD). */
function weekNav(onChange) {
  const q = new URLSearchParams(location.search).get('semana');
  let start = ymd(mondayOf(q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? parseYmd(q) : new Date()));
  const go = (s) => {
    start = s;
    const u = new URL(location.href);
    if (s === ymd(mondayOf(new Date()))) u.searchParams.delete('semana'); else u.searchParams.set('semana', s);
    history.replaceState(null, '', u);
    onChange(start);
  };
  document.getElementById('prev').onclick = () => go(ymd(addDays(parseYmd(start), -7)));
  document.getElementById('next').onclick = () => go(ymd(addDays(parseYmd(start), 7)));
  document.getElementById('today').onclick = () => go(ymd(mondayOf(new Date())));
  return { get start() { return start; }, refresh: () => onChange(start) };
}
