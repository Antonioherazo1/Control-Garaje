const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const perms = require('./permissions');
const { MqttHub } = require('./mqtt');
const google = require('./google');

db.seedAdminIfNeeded();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const mqtt = new MqttHub();
mqtt.start();

let lastPulseAt = 0;

const DOORS = {
  door1: { channel: 1, label: 'Portón 1' },
  door2: { channel: 2, label: 'Portón 2' },
};

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    doors: Array.isArray(u.doors) ? u.doors : [],
    schedule: u.schedule || null,
    dailyLimit: u.dailyLimit || 0,
    expiresAt: u.expiresAt || null,
    temp: !!u.expiresAt,
  };
}

app.post('/api/login', (req, res) => {
  const { user, pin } = req.body || {};
  const u = db.getUserByName(user);
  if (!u || !u.pinHash || !auth.verifyPin(pin, u.salt, u.pinHash)) {
    db.addHistory({
      ts: Date.now(),
      user: String(user || '?'),
      door: null,
      action: 'login',
      result: 'denied',
      reason: 'credenciales_invalidas',
    });
    return res.status(401).json({ error: 'credenciales_invalidas' });
  }
  if (u.expiresAt && Date.now() > u.expiresAt) {
    db.addHistory({ ts: Date.now(), user: u.id, door: null, action: 'login', result: 'denied', reason: 'pin_expirado' });
    return res.status(403).json({ error: 'pin_expirado' });
  }
  db.addHistory({ ts: Date.now(), user: u.id, door: null, action: 'login', result: 'ok' });
  res.json({ token: auth.signToken(u), user: publicUser(u) });
});

app.get('/api/me', auth.authRequired, (req, res) => {
  const u = db.getUser(req.userId);
  if (!u) return res.status(401).json({ error: 'usuario_no_existe' });
  res.json({ user: publicUser(u) });
});

app.get('/api/status', auth.authRequired, (req, res) => {
  const u = db.getUser(req.userId);
  res.json({
    now: Date.now(),
    broker: mqtt.connected,
    deviceOnline: mqtt.deviceOnline,
    deviceInfo: mqtt.deviceInfo,
    doorStates: mqtt.doorStates,
    emergency: mqtt.emergency,
    user: publicUser(u),
  });
});

app.post('/api/command', auth.authRequired, (req, res) => {
  const { door, action } = req.body || {};
  if (!DOORS[door]) return res.status(400).json({ error: 'puerta_invalida' });
  if (!['open', 'close', 'toggle'].includes(action)) return res.status(400).json({ error: 'accion_invalida' });

  const u = db.getUser(req.userId);
  if (!u) return res.status(401).json({ error: 'usuario_no_existe' });

  const check = perms.checkAccess(u, door);
  if (!check.allowed) {
    db.addHistory({ ts: Date.now(), user: u.id, door, action, result: 'denied', reason: check.reason });
    return res.status(403).json({ error: check.reason });
  }

  if (mqtt.emergency) {
    db.addHistory({ ts: Date.now(), user: u.id, door, action, result: 'denied', reason: 'emergencia_activa' });
    return res.status(423).json({ error: 'emergencia_activa' });
  }
  if (!mqtt.connected) {
    db.addHistory({ ts: Date.now(), user: u.id, door, action, result: 'error', reason: 'broker_offline' });
    return res.status(503).json({ error: 'broker_offline' });
  }
  if (!mqtt.deviceOnline) {
    db.addHistory({ ts: Date.now(), user: u.id, door, action, result: 'error', reason: 'dispositivo_offline' });
    return res.status(503).json({ error: 'dispositivo_offline' });
  }

  const now = Date.now();
  if (now - lastPulseAt < config.minPulseGapMs) {
    db.addHistory({ ts: now, user: u.id, door, action, result: 'denied', reason: 'demasiado_rapido' });
    return res.status(429).json({ error: 'demasiado_rapido' });
  }
  lastPulseAt = now;

  db.recordUsage(u.id);
  mqtt.cmdDoor(DOORS[door].channel, action);
  db.addHistory({ ts: now, user: u.id, door, action, result: 'ok' });
  res.json({ ok: true });
});

app.post('/api/test', auth.authRequired, auth.adminRequired, (req, res) => {
  const u = db.getUser(req.userId);
  if (!u) return res.status(401).json({ error: 'usuario_no_existe' });
  if (!mqtt.connected) {
    db.addHistory({ ts: Date.now(), user: u.id, door: null, action: 'test', result: 'error', reason: 'broker_offline' });
    return res.status(503).json({ error: 'broker_offline' });
  }
  if (!mqtt.deviceOnline) {
    db.addHistory({ ts: Date.now(), user: u.id, door: null, action: 'test', result: 'error', reason: 'dispositivo_offline' });
    return res.status(503).json({ error: 'dispositivo_offline' });
  }
  mqtt.testPulse();
  db.addHistory({ ts: Date.now(), user: u.id, door: null, action: 'test', result: 'ok' });
  res.json({ ok: true });
});

app.post('/api/emergency', auth.authRequired, (req, res) => {
  const { action } = req.body || {};
  const u = db.getUser(req.userId);
  if (!u) return res.status(401).json({ error: 'usuario_no_existe' });

  if (action === 'stop') {
    mqtt.emergency('stop');
    mqtt.emergency = true;
    db.addHistory({ ts: Date.now(), user: u.id, door: null, action: 'emergency', result: 'ok' });
    return res.json({ ok: true });
  }
  if (action === 'reset') {
    if (u.role !== 'admin' && !mqtt.emergency) {
      return res.status(403).json({ error: 'forbidden' });
    }
    mqtt.emergency('reset');
    mqtt.emergency = false;
    db.addHistory({ ts: Date.now(), user: u.id, door: null, action: 'emergency_reset', result: 'ok' });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'accion_invalida' });
});

app.get('/api/users', auth.authRequired, auth.adminRequired, (req, res) => {
  res.json({ users: db.users.map(publicUser) });
});

app.post('/api/users', auth.authRequired, auth.adminRequired, (req, res) => {
  const { id, name, pin, role, doors, schedule, dailyLimit } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'datos_incompletos' });
  if (db.getUser(id)) return res.status(409).json({ error: 'id_existe' });
  const user = {
    id: String(id),
    name: String(name),
    role: role === 'admin' ? 'admin' : 'user',
    doors: Array.isArray(doors) && doors.length ? doors : ['door1', 'door2'],
    schedule: schedule && schedule.start && schedule.end ? schedule : { start: '00:00', end: '23:59' },
    dailyLimit: Math.max(0, parseInt(dailyLimit || '0', 10) || 0),
    expiresAt: null,
  };
  if (pin) {
    const { salt, hash } = auth.hashPin(pin);
    user.salt = salt;
    user.pinHash = hash;
  }
  db.addUser(user);
  res.json({ user: publicUser(user) });
});

app.put('/api/users/:id', auth.authRequired, auth.adminRequired, (req, res) => {
  const u = db.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'no_encontrado' });
  const { name, pin, role, doors, schedule, dailyLimit } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = String(name);
  if (role !== undefined) patch.role = role === 'admin' ? 'admin' : 'user';
  if (Array.isArray(doors)) patch.doors = doors.length ? doors : ['door1', 'door2'];
  if (schedule && schedule.start && schedule.end) patch.schedule = schedule;
  if (dailyLimit !== undefined) patch.dailyLimit = Math.max(0, parseInt(dailyLimit, 10) || 0);
  if (pin) {
    const { salt, hash } = auth.hashPin(pin);
    patch.salt = salt;
    patch.pinHash = hash;
  }
  const saved = db.updateUser(u.id, patch);
  res.json({ user: publicUser(saved) });
});

app.delete('/api/users/:id', auth.authRequired, auth.adminRequired, (req, res) => {
  if (String(req.params.id) === 'admin') return res.status(400).json({ error: 'no_eliminar_admin' });
  if (!db.deleteUser(req.params.id)) return res.status(404).json({ error: 'no_encontrado' });
  res.json({ ok: true });
});

app.post('/api/temp-pin', auth.authRequired, auth.adminRequired, (req, res) => {
  const { name, doors, hours, dailyLimit } = req.body || {};
  const h = Math.min(720, Math.max(1, parseInt(hours || '24', 10) || 24));
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  const { salt, hash } = auth.hashPin(pin);
  const user = {
    id: 'temp_' + Date.now().toString(36),
    name: String(name || 'Invitado').slice(0, 40),
    role: 'user',
    salt,
    pinHash: hash,
    doors: Array.isArray(doors) && doors.length ? doors : ['door1', 'door2'],
    schedule: { start: '00:00', end: '23:59' },
    dailyLimit: Math.max(1, parseInt(dailyLimit || '5', 10) || 5),
    expiresAt: Date.now() + h * 3600 * 1000,
  };
  db.addUser(user);
  res.json({ pin, user: publicUser(user) });
});

app.get('/api/history', auth.authRequired, (req, res) => {
  const u = db.getUser(req.userId);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
  const userFilter = u.role === 'admin' ? req.query.user || undefined : u.id;
  res.json({ history: db.getHistory({ user: userFilter, limit }) });
});

app.get('/api/voice', (req, res) => {
  const { token, door } = req.query || {};
  if (!token) return res.status(400).json({ error: 'token_requerido' });

  const vt = db.getVoiceToken(token);
  if (!vt) return res.status(403).json({ error: 'token_invalido' });

  const doorId = door || vt.door;
  if (!DOORS[doorId]) return res.status(400).json({ error: 'puerta_invalida' });

  if (mqtt.emergency) return res.status(423).json({ error: 'emergencia_activa' });
  if (!mqtt.connected) return res.status(503).json({ error: 'broker_offline' });
  if (!mqtt.deviceOnline) return res.status(503).json({ error: 'dispositivo_offline' });

  const now = Date.now();
  if (now - lastPulseAt < config.minPulseGapMs) {
    return res.status(429).json({ error: 'demasiado_rapido' });
  }
  lastPulseAt = now;

  mqtt.cmdDoor(DOORS[doorId].channel, 'toggle');
  db.addHistory({ ts: now, user: 'voice:' + vt.name, door: doorId, action: 'toggle', result: 'ok' });
  res.json({ ok: true, door: doorId });
});

app.get('/api/voice-tokens', auth.authRequired, auth.adminRequired, (req, res) => {
  res.json({ tokens: db.getVoiceTokens() });
});

app.post('/api/voice-tokens', auth.authRequired, auth.adminRequired, (req, res) => {
  const { name, door } = req.body || {};
  if (!name) return res.status(400).json({ error: 'nombre_requerido' });
  if (door && !DOORS[door]) return res.status(400).json({ error: 'puerta_invalida' });
  const token = db.addVoiceToken(name, door || 'door1');
  res.json({ token });
});

app.delete('/api/voice-tokens/:id', auth.authRequired, auth.adminRequired, (req, res) => {
  if (!db.deleteVoiceToken(req.params.id)) return res.status(404).json({ error: 'no_encontrado' });
  res.json({ ok: true });
});

// Google Smart Home fulfillment
app.post('/api/google/smart-home', (req, res) => {
  try {
    console.log('[google] fulfillment:', JSON.stringify(req.body).substring(0, 300));
    const result = google.handleFulfillment(req.body, mqtt, req.headers.authorization);
    res.json(result);
  } catch (e) {
    console.error('[google] fulfillment error:', e.message);
    res.json({ requestId: (req.body && req.body.requestId) || '', payload: {} });
  }
});

// Google request sync - force Google to re-read devices
app.post('/api/google/request-sync', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const apiKey = process.env.GOOGLE_API_KEY || '';
    if (!apiKey) return res.status(400).json({ error: 'GOOGLE_API_KEY no configurado en .env' });
    const url = 'https://homegraph.googleapis.com/v1/devices:requestSync?key=' + apiKey;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentUserId: 'admin' }),
    });
    const data = await response.json();
    console.log('[google] request-sync response:', JSON.stringify(data));
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[google] request-sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google OAuth2 - authorization page (serves a login form)
app.get('/api/google/auth', (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query || {};
  if (response_type !== 'code') return res.status(400).send('response_type must be code');
  if (!redirect_uri) return res.status(400).send('redirect_uri required');
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Garage Control - Vincular con Google</title>
<style>
  body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
  .card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px;width:340px}
  h1{font-size:1.2rem;margin:0 0 4px;text-align:center}
  p{font-size:.85rem;color:#94a3b8;text-align:center;margin:0 0 20px}
  label{font-size:.85rem;color:#94a3b8;display:block;margin-bottom:4px}
  input{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:.9rem;box-sizing:border-box;margin-bottom:12px}
  input:focus{outline:none;border-color:#22c55e}
  button{width:100%;padding:12px;border:none;border-radius:10px;background:#22c55e;color:#052e16;font-weight:700;font-size:1rem;cursor:pointer}
  button:active{transform:scale(.97)}
  .err{color:#fca5a5;font-size:.85rem;text-align:center;margin-top:8px}
</style></head><body>
<div class="card">
  <h1>Vincular Garage Control</h1>
  <p>Ingresa tus credenciales para conectar con Google</p>
  <form method="POST" action="/api/google/auth">
    <input type="hidden" name="client_id" value="${client_id || ''}">
    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
    <input type="hidden" name="state" value="${state || ''}">
    <label for="user">Usuario</label>
    <input id="user" name="user" type="text" autocomplete="username" required>
    <label for="pin">PIN</label>
    <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required>
    <button type="submit">Vincular</button>
  </form>
</div></body></html>`);
});

// Google OAuth2 - authenticate and redirect back with code
app.post('/api/google/auth', (req, res) => {
  const { user, pin, client_id, redirect_uri, state } = req.body || {};
  const u = db.getUserByName(user);
  if (!u || !u.pinHash || !auth.verifyPin(pin, u.salt, u.pinHash)) {
    return res.status(401).send('Usuario o PIN incorrecto');
  }
  const code = google.genAuthCode(u.id);
  const sep = redirect_uri.includes('?') ? '&' : '?';
  const redir = redirect_uri + sep + 'code=' + code + (state ? '&state=' + encodeURIComponent(state) : '');
  res.redirect(redir);
});

// Google OAuth2 - token exchange
app.post('/api/google/token', (req, res) => {
  const { grant_type, code, refresh_token } = req.body || {};
  const clientSecret = req.headers.authorization || '';
  const basicAuth = clientSecret.startsWith('Basic ') ? Buffer.from(clientSecret.slice(6), 'base64').toString() : '';
  const [cid] = basicAuth.split(':');

  if (grant_type === 'authorization_code') {
    const result = google.exchangeCode(code);
    if (!result) return res.status(400).json({ error: 'invalid_grant' });
    res.json({ token_type: 'Bearer', access_token: result.accessToken, refresh_token: result.refreshToken, expires_in: result.expiresIn });
  } else if (grant_type === 'refresh_token') {
    const result = google.refreshAccessToken(refresh_token);
    if (!result) return res.status(400).json({ error: 'invalid_grant' });
    res.json({ token_type: 'Bearer', access_token: result.accessToken, expires_in: result.expiresIn });
  } else {
    res.status(400).json({ error: 'unsupported_grant_type' });
  }
});

// Google OAuth2 - redirect callback (Google redirects here after auth)
app.get('/api/google/oauth2callback', (req, res) => {
  const { code, state } = req.query || {};
  if (!code) return res.status(400).send('Missing code');
  res.send(`<script>opener.postMessage({code:'${code}',state:'${state||''}'},'*');window.close();</script><p>Puedes cerrar esta ventana.</p>`);
});

// Google OAuth2 - OpenID configuration
app.get('/.well-known/openid-configuration', (req, res) => {
  res.json({
    issuer: 'https://garaje.thinc.site',
    authorization_endpoint: 'https://garaje.thinc.site/api/google/auth',
    token_endpoint: 'https://garaje.thinc.site/api/google/token',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use(express.static(config.publicDir));
app.get('*', (req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));

app.listen(config.port, () => {
  console.log(`[server] escuchando en http://0.0.0.0:${config.port}`);
});
