const $ = (id) => document.getElementById(id);
let nav = null;
let current = null; // { slot, day }

async function showView() {
  const { authed } = await api('/api/session');
  $('loginView').hidden = authed;
  $('adminView').hidden = !authed;
  if (authed) {
    if (!nav) nav = weekNav(load);
    nav.refresh();
  } else {
    $('user').focus();
  }
}

// ---------- Login ----------
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { user: $('user').value.trim(), password: $('password').value } });
    $('password').value = '';
    showView();
  } catch (err) { $('loginErr').textContent = err.message; }
});
$('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); showView(); };

function handleAuthError(err) {
  if (err.status === 401) { showView(); return true; }
  return false;
}

// ---------- Semana ----------
async function load(start) {
  $('range').textContent = rangeLabel(start);
  try {
    const week = await api('/api/admin/week?start=' + start);
    renderWeek($('week'), week, {
      slotContent: (s) => {
        if (s.status === 'free') return { cls: 'free', label: 'Libre — tocá para reservar', sub: 'Libre', clickable: true };
        if (s.status === 'blocked') return { cls: 'blocked', label: 'Bloqueado' + (s.booking.note ? ' — ' + s.booking.note : ''), sub: 'Bloqueado', clickable: true };
        return { cls: 'booked', label: s.booking.name + (s.booking.note ? ' — ' + s.booking.note : ''), sub: s.booking.name, clickable: true };
      },
      onSlot: openBooking,
    });
    $('err').textContent = '';
  } catch (err) {
    if (!handleAuthError(err)) $('err').textContent = 'No se pudo cargar la agenda: ' + err.message;
  }
}

// ---------- Reservas ----------
const typeVal = () => document.querySelector('input[name=type]:checked').value;
function syncType() { $('nameRow').hidden = typeVal() === 'blocked'; }
document.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', syncType));

function openBooking(slot, day) {
  current = { slot, day };
  const b = slot.booking;
  $('bTitle').textContent = b ? (b.type === 'blocked' ? 'Hora bloqueada' : 'Clase reservada') : 'Reservar horario';
  $('bWhen').textContent = `${DAY_NAMES[day.weekday]} ${shortDate(day.date)} · ${slot.time}` + (b && b.group ? ' · se repite semanalmente' : '');
  document.querySelector(`input[name=type][value=${b && b.type === 'blocked' ? 'blocked' : 'booking'}]`).checked = true;
  $('bName').value = b ? b.name : '';
  $('bNote').value = b ? b.note || '' : '';
  $('bRepeat').value = '1';
  $('repeatRow').hidden = !!b;
  $('bDelete').hidden = !b;
  $('bDeleteSeries').hidden = !(b && b.group);
  $('bErr').textContent = '';
  syncType();
  $('bookingDlg').showModal();
  if (typeVal() === 'booking') $('bName').focus();
}

$('bookingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { slot, day } = current;
  const body = { type: typeVal(), name: $('bName').value, note: $('bNote').value };
  try {
    if (slot.booking) {
      await api('/api/admin/bookings/' + slot.booking.id, { method: 'PUT', body });
    } else {
      const r = await api('/api/admin/bookings', { method: 'POST', body: { ...body, date: day.date, time: slot.time, repeatWeeks: $('bRepeat').value } });
      if (r.skipped.length) alert('Algunas semanas ya estaban ocupadas y se saltearon:\n' + r.skipped.map(shortDate).join(', '));
    }
    $('bookingDlg').close();
    nav.refresh();
  } catch (err) { if (!handleAuthError(err)) $('bErr').textContent = err.message; }
});

async function del(series) {
  const b = current.slot.booking;
  const msg = series ? '¿Liberar esta clase y todas las siguientes de la serie?' : '¿Liberar este horario?';
  if (!confirm(msg)) return;
  try {
    await api('/api/admin/bookings/' + b.id + (series ? '?series=1' : ''), { method: 'DELETE' });
    $('bookingDlg').close();
    nav.refresh();
  } catch (err) { if (!handleAuthError(err)) $('bErr').textContent = err.message; }
}
$('bDelete').onclick = () => del(false);
$('bDeleteSeries').onclick = () => del(true);
$('bCancel').onclick = () => $('bookingDlg').close();

// ---------- Configuración de horarios ----------
const ORDER = [1, 2, 3, 4, 5, 6, 0];
$('settingsBtn').onclick = async () => {
  try {
    const s = await api('/api/admin/settings');
    $('sTitle').value = s.title;
    $('sSlot').value = String(s.slotMinutes);
    $('daysCfg').replaceChildren(...ORDER.flatMap((i) => {
      const d = s.days[i];
      return [
        el('label', { class: 'dname' }, el('input', { type: 'checkbox', id: 'en' + i, checked: d.enabled ? '' : false }), DAY_NAMES[i]),
        el('input', { type: 'time', id: 'st' + i, value: d.start, 'aria-label': `Inicio ${DAY_NAMES[i]}` }),
        el('input', { type: 'time', id: 'et' + i, value: d.end, 'aria-label': `Fin ${DAY_NAMES[i]}` }),
      ];
    }));
    $('sErr').textContent = '';
    $('settingsDlg').showModal();
  } catch (err) { handleAuthError(err); }
};
$('sCancel').onclick = () => $('settingsDlg').close();
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const days = {};
  for (let i = 0; i < 7; i++) days[i] = { enabled: $('en' + i).checked, start: $('st' + i).value, end: $('et' + i).value };
  try {
    await api('/api/admin/settings', { method: 'PUT', body: { title: $('sTitle').value, slotMinutes: Number($('sSlot').value), days } });
    $('settingsDlg').close();
    nav.refresh();
  } catch (err) { if (!handleAuthError(err)) $('sErr').textContent = err.message; }
});

showView();
