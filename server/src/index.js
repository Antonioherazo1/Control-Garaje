const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const perms = require('./permissions');
const { MqttHub } = require('./mqtt');

db.seedAdminIfNeeded();

const app = express();
app.use(express.json());

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

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use(express.static(config.publicDir));
app.get('*', (req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));

app.listen(config.port, () => {
  console.log(`[server] escuchando en http://0.0.0.0:${config.port}`);
});
