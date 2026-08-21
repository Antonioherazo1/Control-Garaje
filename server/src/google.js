const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const https = require('https');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'garaje-control';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'garaje-secret';
const REDIRECT = process.env.GOOGLE_REDIRECT_URI || 'https://garaje.thinc.site/api/google/oauth2callback';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';

const authCodes = new Map();
const tokens = new Map();

const doorStates = { door1: false, door2: false };

function reportState(agentUserId, deviceId, states) {
  if (!GOOGLE_API_KEY) return;
  const requestId = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({
    requestId,
    agentUserId,
    payload: { devices: { states: { [deviceId]: states } } },
  });
  const url = new URL('https://homegraph.googleapis.com/v1/devices:reportState?key=' + GOOGLE_API_KEY);
  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let data = '';
    res.on('data', (c) => data += c);
    res.on('end', () => console.log('[google] reportState:', res.statusCode, data.substring(0, 200)));
  });
  req.on('error', (e) => console.error('[google] reportState error:', e.message));
  req.write(body);
  req.end();
}

function deviceList() {
  return [
    {
      id: 'door1', type: 'action.devices.types.GATE',
      traits: ['action.devices.traits.OpenClose'],
      name: { defaultNames: ['Porton Abatible'], name: 'Porton Abatible', nicknames: ['porton', 'abatible', 'el porton', 'porton abatible', 'gate', 'the gate'] },
      willReportState: false,
      attributes: { commandOnlyOpenClose: true },
    },
    {
      id: 'door2', type: 'action.devices.types.GATE',
      traits: ['action.devices.traits.OpenClose'],
      name: { defaultNames: ['Reja Corrediza'], name: 'Reja Corrediza', nicknames: ['reja', 'corrediza', 'la reja', 'reja corrediza', 'grill', 'the grill'] },
      willReportState: false,
      attributes: { commandOnlyOpenClose: true },
    },
    {
      id: 'doorAll', type: 'action.devices.types.GATE',
      traits: ['action.devices.traits.OpenClose'],
      name: { defaultNames: ['Las Puertas'], name: 'Las Puertas', nicknames: ['puertas', 'las puertas', 'los portones', 'portones', 'ambas puertas', 'todas las puertas', 'doors', 'the doors'] },
      willReportState: false,
      attributes: { commandOnlyOpenClose: true },
    },
  ];
}

function sync(userId) {
  const user = db.getUser(userId);
  const allowed = user && user.role === 'admin' ? deviceList()
    : deviceList().filter((d) => user && user.doors && user.doors.includes(d.id));
  return { agentUserId: userId, devices: allowed };
}

function query(userId) {
  const user = db.getUser(userId);
  const ids = user && user.role === 'admin' ? ['door1', 'door2', 'doorAll'] : (user && user.doors) || [];
  const devices = {};
  ids.forEach((id) => { devices[id] = { online: true, status: 'SUCCESS', open: doorStates[id] || false }; });
  return { devices };
}

function execute(userId, commands, mqttHub) {
  const user = db.getUser(userId);
  const results = [];
  for (const cmd of commands) {
    for (const dev of (cmd.devices || [])) {
      const devId = typeof dev === 'string' ? dev : (dev.id || dev);
      if (!['door1', 'door2', 'doorAll'].includes(devId)) {
        results.push({ ids: [devId], status: 'ERROR', errorCode: 'deviceNotFound' });
        continue;
      }
      if (user && user.role !== 'admin' && !(user.doors && (user.doors.includes(devId) || user.doors.includes('door1') && user.doors.includes('door2')))) {
        results.push({ ids: [devId], status: 'ERROR', errorCode: 'functionNotSupported' });
        continue;
      }
      for (const exec of (cmd.execution || [])) {
        if (exec.command === 'action.devices.commands.OpenClose' || exec.command === 'action.devices.commands.OnOff') {
          const CH = { door1: 1, door2: 2 };
          const targets = devId === 'doorAll' ? ['door1', 'door2'] : [devId];
          const open = exec.params && exec.params.open !== undefined ? exec.params.open : !doorStates[devId];
          targets.forEach((t, i) => {
            setTimeout(() => mqttHub.cmdDoor(CH[t], 'toggle'), i * 600);
            doorStates[t] = open;
          });
          db.addHistory({ ts: Date.now(), user: 'google:' + userId, door: devId, action: 'toggle', result: 'ok' });
          const states = { online: true, status: 'SUCCESS', open };
          results.push({ ids: [devId], status: 'SUCCESS', states });
          reportState(userId, devId, states);
        } else {
          results.push({ ids: [devId], status: 'ERROR', errorCode: 'functionNotSupported' });
        }
      }
    }
  }
  return { commands: results };
}

function handleFulfillment(body, mqttHub, authHeader) {
  const rid = (body && body.requestId) || '';
  const input = body && body.inputs && body.inputs[0];
  if (!input) return { requestId: rid, payload: {} };
  const intent = input.intent;

  let userId = 'admin';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const accessToken = authHeader.slice(7);
    const data = tokens.get(accessToken);
    if (data) userId = data.userId;
  }

  console.log('[google] intent:', intent, 'userId:', userId, 'requestId:', rid);

  switch (intent) {
    case 'action.devices.SYNC':
      return { requestId: rid, payload: sync(userId) };
    case 'action.devices.QUERY':
      return { requestId: rid, payload: query(userId) };
    case 'action.devices.EXECUTE':
      return { requestId: rid, payload: execute(userId, input.payload && input.payload.commands || [], mqttHub) };
    case 'action.devices.DISCONNECT':
      return { requestId: rid, payload: {} };
    default:
      console.log('[google] unknown intent:', intent);
      return { requestId: rid, payload: {} };
  }
}

function genAuthCode(userId) {
  const code = crypto.randomBytes(16).toString('hex');
  authCodes.set(code, { userId, ts: Date.now() });
  setTimeout(() => authCodes.delete(code), 10 * 60 * 1000);
  return code;
}

function exchangeCode(code) {
  const entry = authCodes.get(code);
  if (!entry) return null;
  authCodes.delete(code);
  const user = db.getUser(entry.userId);
  if (!user) return null;
  const accessToken = 'gtok_' + crypto.randomBytes(24).toString('hex');
  tokens.set(accessToken, { userId: user.id, ts: Date.now() });
  const refreshToken = 'gref_' + crypto.randomBytes(24).toString('hex');
  tokens.set(refreshToken, { userId: user.id, ts: Date.now() });
  return { accessToken, refreshToken, expiresIn: 8 * 3600 };
}

function refreshAccessToken(refreshToken) {
  const data = tokens.get(refreshToken);
  if (!data) return null;
  const user = db.getUser(data.userId);
  if (!user) return null;
  const accessToken = 'gtok_' + crypto.randomBytes(24).toString('hex');
  tokens.set(accessToken, { userId: user.id, ts: Date.now() });
  return { accessToken, expiresIn: 8 * 3600 };
}

module.exports = { handleFulfillment, genAuthCode, exchangeCode, refreshAccessToken, CLIENT_ID, CLIENT_SECRET, REDIRECT, reportState, doorStates };
