const API = '/api';
const state = {
  token: localStorage.getItem('token') || null,
  user: null,
  status: null,
  poll: null,
  history: [],
  currentView: 'home',
};

const $ = (id) => document.getElementById(id);

const MSG = {
  credenciales_invalidas: 'Usuario o PIN incorrecto',
  pin_expirado: 'El PIN ha expirado',
  puerta_no_permitida: 'No tienes permiso para esta puerta',
  fuera_de_horario: 'Fuera del horario permitido',
  limite_diario: 'Limite diario de usos alcanzado',
  emergencia_activa: 'Sistema en emergencia',
  broker_offline: 'Servidor sin conexion MQTT',
  dispositivo_offline: 'Dispositivo ESP8266 sin conexion',
  demasiado_rapido: 'Espera unos segundos entre pulsos',
  puerta_invalida: 'Puerta invalida',
  accion_invalida: 'Accion invalida',
  no_token: 'Sesion no iniciada',
  token_invalido: 'La sesion expiro, vuelve a entrar',
  id_existe: 'El usuario ya existe',
  no_encontrado: 'No encontrado',
  forbidden: 'Sin permisos de administrador',
  no_eliminar_admin: 'No puedes eliminar al admin',
  datos_incompletos: 'Datos incompletos',
  nombre_requerido: 'Nombre requerido',
  token_requerido: 'Token requerido',
  token_invalido: 'Token de voz invalido',
  not_found: 'Recurso no encontrado',
};

function tr(code) {
  return MSG[code] || code || 'Error desconocido';
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token && path !== '/login') {
      logout();
    }
    const err = new Error(data.error || 'error_desconocido');
    err.code = res.status;
    throw err;
  }
  return data;
}

function showView(name) {
  $('view-login').classList.toggle('hidden', name !== 'login');
  $('view-app').classList.toggle('hidden', name !== 'app');
}

/* ---------------- Login ---------------- */

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  $('login-btn').disabled = true;
  try {
    const data = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ user: $('login-user').value.trim(), pin: $('login-pin').value.trim() }),
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('token', data.token);
    enterApp();
  } catch (err) {
    $('login-error').textContent = tr(err.message);
  } finally {
    $('login-btn').disabled = false;
    $('login-pin').value = '';
  }
});

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
  showView('login');
}

$('btn-logout').addEventListener('click', logout);

/* ---------------- Entrada a la app ---------------- */

async function enterApp() {
  showView('app');
  renderUser();
  setupNav();
  initNetworksBtn();
  await refreshStatus();
  loadHistory();
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(refreshStatus, 5000);
}

function renderUser() {
  const role = state.user.role === 'admin' ? 'Admin' : 'Usuario';
  $('user-label').textContent = state.user.name + ' · ' + role;
}

/* ---------------- Navegacion ---------------- */

function setupNav() {
  const isAdmin = state.user && state.user.role === 'admin';
  document.querySelectorAll('.nav-admin').forEach((btn) => {
    btn.classList.toggle('hidden', !isAdmin);
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  switchView('home');
}

function switchView(name) {
  state.currentView = name;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== 'panel-' + name);
  });
  if (name === 'historial') loadHistory();
  if (name === 'users') loadUsers();
  if (name === 'voice') loadVoiceTokens();
}

/* ---------------- WiFi Icon ---------------- */

function updateWifiIcon(rssi) {
  const icon = $('wifi-icon');
  if (rssi === undefined || rssi === null) {
    icon.setAttribute('data-level', '0');
    return;
  }
  let level = 0;
  if (rssi >= -50) level = 4;
  else if (rssi >= -60) level = 3;
  else if (rssi >= -70) level = 2;
  else if (rssi >= -80) level = 1;
  icon.setAttribute('data-level', String(level));
  icon.title = 'WiFi: ' + rssi + ' dBm';
}

/* ---------------- Status ---------------- */

async function refreshStatus() {
  try {
    const data = await api('/status');
    state.status = data;
    renderStatus();
    renderSavedNetworks();
    if (!state.user) {
      state.user = data.user;
      renderUser();
      setupNav();
    }
  } catch {
    renderStatus();
  }
}

function renderStatus() {
  const s = state.status;
  const device = $('status-device');
  if (!s) {
    device.className = 'pill offline';
    device.textContent = 'Dispositivo: —';
    updateWifiIcon(null);
    return;
  }
  if (s.deviceOnline) {
    device.className = 'pill online';
    const info = s.deviceInfo || {};
    const rssi = info.rssi !== undefined ? ' · ' + info.rssi + ' dBm' : '';
    const net = info.ssid ? ' · ' + info.ssid : '';
    device.textContent = 'Dispositivo: en linea' + net + rssi;
    updateWifiIcon(info.rssi);
  } else {
    device.className = 'pill offline';
    device.textContent = s.broker ? 'Dispositivo: sin conexion' : 'Dispositivo: —';
    updateWifiIcon(null);
  }
  renderDoors();
}

/* ---------------- Puertas ---------------- */

function doorStateLabel(st) {
  return { open: 'Abierta', closed: 'Cerrada', unknown: 'Desconocido' }[st] || 'Desconocido';
}

function renderDoors() {
  const cont = $('doors');
  const doors = [
    { id: 'door1', label: 'Porton Abatible' },
    { id: 'door2', label: 'Reja Corrediza' },
  ];
  const allowed = state.user && state.user.role === 'admin'
    ? doors
    : doors.filter((d) => state.user && state.user.doors.includes(d.id));

  cont.innerHTML = '';
  allowed.forEach((d) => {
    const st = (state.status && state.status.doorStates[d.id]) || 'unknown';
    const card = document.createElement('div');
    card.className = 'door';
    card.innerHTML =
      '<h3>' + d.label + '</h3>' +
      '<p class="muted door-state" data-state="' + st + '">Estado: ' + doorStateLabel(st) + '</p>' +
      '<div class="btn-row">' +
      '  <button class="cmd" data-door="' + d.id + '" data-action="toggle">Accionar</button>' +
      '</div>';
    cont.appendChild(card);
  });
  cont.querySelectorAll('.cmd').forEach((btn) => btn.addEventListener('click', onCommand));
}

async function onCommand(e) {
  const btn = e.currentTarget;
  const door = btn.dataset.door;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    await api('/command', {
      method: 'POST',
      body: JSON.stringify({ door, action }),
    });
  } catch (err) {
    alert(tr(err.message));
  } finally {
    setTimeout(() => { btn.disabled = false; }, 600);
  }
}

/* ---------------- Prueba del dispositivo ---------------- */

$('btn-test').addEventListener('click', async () => {
  const btn = $('btn-test');
  btn.disabled = true;
  try {
    await api('/test', { method: 'POST' });
    alert('Pulso de prueba enviado (LED + salida D6).');
  } catch (err) {
    alert(tr(err.message));
  } finally {
    setTimeout(() => { btn.disabled = false; }, 600);
  }
});

$('wifi-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ssid = $('wifi-ssid').value.trim();
  const pass = $('wifi-pass').value;
  if (!ssid || !pass) return;
  try {
    const data = await api('/wifi/network', {
      method: 'POST',
      body: JSON.stringify({ ssid, pass }),
      headers: { 'Content-Type': 'application/json' },
    });
    alert(data.message || 'Red agregada.');
    $('wifi-form').reset();
  } catch (err) {
    alert(tr(err.message));
  }
});

/* ---------------- Redes WiFi guardadas ---------------- */

function renderSavedNetworks() {
  const el = $('saved-networks');
  const now = $('status-wifi-now');
  const s = state.status;
  if (now && s && s.deviceInfo && s.deviceInfo.ssid) {
    now.textContent = 'Red actual: ' + s.deviceInfo.ssid + (s.deviceInfo.ip ? ' (' + s.deviceInfo.ip + ')' : '');
  } else if (now) {
    now.textContent = 'Red actual: —';
  }
  if (!el) return;
  const nets = (s && s.savedNetworks) || [];
  if (!nets.length) {
    el.innerHTML = '<p class="muted">No hay redes guardadas.</p>';
    return;
  }
  el.innerHTML = '';
  nets.forEach((net) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = '<span>' + net + '</span>';
    el.appendChild(row);
  });
}

var _networksBtnInit = false;
function initNetworksBtn() {
  if (_networksBtnInit) return;
  _networksBtnInit = true;
  const btn = $('btn-refresh-networks');
  if (btn) btn.addEventListener('click', () => { refreshStatus(); });
  const reset = $('btn-wifi-reset');
  if (reset) reset.addEventListener('click', () => {
    if (!confirm('¿Borrar TODAS las redes WiFi guardadas en el ESP? Se abrira el portal de configuracion (AP "GarageControl").')) return;
    reset.disabled = true;
    api('/wifi/reset', { method: 'POST' })
      .then(() => alert('Comando enviado. Espera ~10s, luego conectate al AP "GarageControl" (clave 12345678) y entra a http://192.168.4.1 para configurar la nueva red.'))
      .catch((err) => alert(tr(err.message)))
      .finally(() => setTimeout(() => { reset.disabled = false; }, 600));
  });
}

/* ---------------- Historial ---------------- */

async function loadHistory() {
  try {
    const data = await api('/history?limit=30');
    renderHistory(data.history || []);
  } catch {
    $('history-list').innerHTML = '<p class="muted">No se pudo cargar el historial</p>';
  }
}

function renderHistory(events) {
  const el = $('history-list');
  if (!events.length) {
    el.innerHTML = '<p class="muted">Sin actividad todavia</p>';
    return;
  }
  const rows = events.map((ev) => {
    const when = new Date(ev.ts).toLocaleString();
    const action = { toggle: 'Accionar', open: 'Abrir', close: 'Cerrar', test: 'Prueba', login: 'Login', emergency: 'Emergencia', emergency_reset: 'Restablecer' }[ev.action] || ev.action;
    const what = ev.door ? ({ door1: 'Porton Abatible', door2: 'Reja Corrediza' }[ev.door] || ev.door) + ' ' + action : action;
    const cls = ev.result === 'ok' ? 'badge-ok' : ev.result === 'denied' ? 'badge-denied' : 'badge-error';
    return '<tr><td>' + when + '</td><td>' + escapeHtml(ev.user) + '</td><td>' + escapeHtml(what) + '</td><td class="' + cls + '">' + escapeHtml(ev.result) + '</td></tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>Fecha</th><th>Usuario</th><th>Accion</th><th>Resultado</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

$('btn-refresh-history').addEventListener('click', loadHistory);

/* ---------------- Admin ---------------- */

async function loadUsers() {
  try {
    const data = await api('/users');
    renderUsers(data.users || []);
  } catch {
    $('users-list').innerHTML = '<p class="muted">No se pudieron cargar los usuarios</p>';
  }
}

function renderUsers(users) {
  const el = $('users-list');
  el.innerHTML = '';
  users.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'user-item';
    const doors = (u.doors || []).map((d) => ({ door1: 'Abatible', door2: 'Reja' }[d] || d)).join(', ');
    const sched = u.schedule ? u.schedule.start + ' - ' + u.schedule.end : '24/7';
    const limit = u.dailyLimit > 0 ? 'max ' + u.dailyLimit + '/dia' : 'sin limite';
    const extra = u.temp ? ' · TEMPORAL' : '';
    const del = u.id !== 'admin'
      ? '<button class="mini-danger" data-del="' + escapeAttr(u.id) + '">Eliminar</button>'
      : '';
    item.innerHTML =
      '<div><strong>' + escapeHtml(u.name) + '</strong>' +
      '<div class="meta">' + escapeHtml(u.id) + ' · ' + escapeHtml(doors) + ' · ' + escapeHtml(sched) + ' · ' + escapeHtml(limit) + extra + '</div></div>' +
      '<div>' + del + '</div>';
    el.appendChild(item);
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar al usuario?')) return;
      try {
        await api('/users/' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' });
        loadUsers();
      } catch (err) {
        alert(tr(err.message));
      }
    });
  });
}

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = $('user-result');
  result.classList.add('hidden');
  const doors = Array.from(document.querySelectorAll('#user-form input[type="checkbox"]:checked')).map((c) => c.value);
  try {
    await api('/users', {
      method: 'POST',
      body: JSON.stringify({
        id: $('user-id').value.trim().toLowerCase(),
        name: $('user-name').value.trim(),
        pin: $('user-pin').value.trim(),
        doors,
        schedule: { start: $('user-start').value || '00:00', end: $('user-end').value || '23:59' },
        dailyLimit: parseInt($('user-limit').value || '0', 10),
      }),
    });
    result.textContent = 'Usuario creado: ' + $('user-name').value.trim();
    result.classList.remove('hidden');
    $('user-form').reset();
    $('user-start').value = '00:00';
    $('user-end').value = '23:59';
    $('user-limit').value = '0';
    loadUsers();
  } catch (err) {
    alert(tr(err.message));
  }
});

$('temp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = $('temp-result');
  result.classList.add('hidden');
  const doors = Array.from(document.querySelectorAll('#temp-form input[type="checkbox"]:checked')).map((c) => c.value);
  try {
    const data = await api('/temp-pin', {
      method: 'POST',
      body: JSON.stringify({
        name: $('temp-name').value.trim(),
        doors,
        hours: parseInt($('temp-hours').value || '24', 10),
      }),
    });
    result.textContent = 'PIN temporal para ' + (data.user.name || 'Invitado') + ': ' + data.pin + ' (valido ' + data.user.dailyLimit + ' usos, ' + $('temp-hours').value + 'h)';
    result.classList.remove('hidden');
    loadUsers();
  } catch (err) {
    alert(tr(err.message));
  }
});

/* ---------------- Voz / Siri ---------------- */

async function loadVoiceTokens() {
  try {
    const data = await api('/voice-tokens');
    renderVoiceTokens(data.tokens || []);
  } catch {
    $('voice-tokens-list').innerHTML = '<p class="muted">No se pudieron cargar los tokens</p>';
  }
}

function renderVoiceTokens(tokens) {
  const el = $('voice-tokens-list');
  el.innerHTML = '';
  if (!tokens.length) {
    el.innerHTML = '<p class="muted" style="margin-top:12px">No hay tokens creados</p>';
    return;
  }
  tokens.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'voice-token-item';
    const doorLabel = { door1: 'Abatible', door2: 'Reja' }[t.door] || t.door;
    const created = new Date(t.createdAt).toLocaleDateString();
    item.innerHTML =
      '<div>' +
      '<strong>' + escapeHtml(t.name) + '</strong>' +
      '<div class="meta">' + escapeHtml(doorLabel) + ' · ' + created + '</div>' +
      '<span class="voice-token-url" title="Toca para copiar" data-url="' + escapeAttr(t.url) + '">' + escapeHtml(t.url) + '</span>' +
      '</div>' +
      '<button class="mini-danger" data-del-token="' + escapeAttr(t.id) + '">Eliminar</button>';
    el.appendChild(item);
  });
  el.querySelectorAll('.voice-token-url').forEach((el) => {
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.dataset.url).then(() => {
        el.style.color = 'var(--accent)';
        el.textContent = 'Copiado!';
        setTimeout(() => { el.style.color = ''; el.textContent = el.dataset.url; }, 1500);
      }).catch(() => {
        prompt('Copia la URL:', el.dataset.url);
      });
    });
  });
  el.querySelectorAll('[data-del-token]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este token de voz?')) return;
      try {
        await api('/voice-tokens/' + encodeURIComponent(btn.dataset.delToken), { method: 'DELETE' });
        loadVoiceTokens();
      } catch (err) {
        alert(tr(err.message));
      }
    });
  });
}

$('voice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('voice-name').value.trim();
  if (!name) return;
  try {
    await api('/voice-tokens', {
      method: 'POST',
      body: JSON.stringify({ name, door: $('voice-door').value }),
    });
    $('voice-name').value = '';
    loadVoiceTokens();
  } catch (err) {
    alert(tr(err.message));
  }
});

/* ---------------- Utilidades ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

/* ---------------- Arranque ---------------- */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(async function init() {
  if (!state.token) {
    showView('login');
    return;
  }
  try {
    const data = await api('/me');
    state.user = data.user;
    enterApp();
  } catch {
    showView('login');
  }
})();
