const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'garaje-control';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'garaje-secret';
const REDIRECT = process.env.GOOGLE_REDIRECT_URI || 'https://garaje.thinc.site/api/google/oauth2callback';

const authCodes = new Map();
const tokens = new Map();

function deviceList() {
  return [
    {
      id: 'door1', type: 'action.devices.types.GATE',
      traits: ['action.devices.traits.OpenClose'],
      name: { defaultNames: ['Porton Abatible'], name: 'Porton Abatible', nicknames: ['porton', 'abatible', 'porton abatible'] },
      willReportState: false,
    },
    {
      id: 'door2', type: 'action.devices.types.GATE',
      traits: ['action.devices.traits.OpenClose'],
      name: { defaultNames: ['Reja Corrediza'], name: 'Reja Corrediza', nicknames: ['reja', 'corrediza'] },
      willReportState: false,
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
  const ids = user && user.role === 'admin' ? ['door1', 'door2'] : (user && user.doors) || [];
  const devices = {};
  ids.forEach((id) => { devices[id] = { online: true, status: 'SUCCESS' }; });
  return { devices };
}

function execute(userId, commands, mqttHub) {
  const user = db.getUser(userId);
  const results = [];
  for (const cmd of commands) {
    for (const devId of (cmd.devices || [])) {
      if (!['door1', 'door2'].includes(devId)) {
        results.push({ ids: [devId], status: 'ERROR', errorCode: 'deviceNotFound' });
        continue;
      }
      if (user && user.role !== 'admin' && !(user.doors && user.doors.includes(devId))) {
        results.push({ ids: [devId], status: 'ERROR', errorCode: 'functionNotSupported' });
        continue;
      }
      for (const exec of (cmd.execution || [])) {
        if (exec.command === 'action.devices.commands.OpenClose' || exec.command === 'action.devices.commands.OnOff') {
          const CH = { door1: 1, door2: 2 };
          mqttHub.cmdDoor(CH[devId], 'toggle');
          db.addHistory({ ts: Date.now(), user: 'google:' + userId, door: devId, action: 'toggle', result: 'ok' });
          results.push({ ids: [devId], status: 'SUCCESS', states: { online: true, open: exec.params && exec.params.open !== undefined ? exec.params.open : undefined } });
        } else {
          results.push({ ids: [devId], status: 'ERROR', errorCode: 'functionNotSupported' });
        }
      }
    }
  }
  return { results };
}

function handleFulfillment(body, mqttHub) {
  const rid = (body && body.requestId) || '';
  const input = body && body.inputs && body.inputs[0];
  if (!input) return { requestId: rid, payload: {} };
  const intent = input.intent;
  const tok = body.authorizationCode || 'admin';
  const data = tokens.get(tok);
  const userId = data ? data.userId : 'admin';

  switch (intent) {
    case 'action.devices.SYNC':
      return { requestId: rid, payload: sync(userId) };
    case 'action.devices.QUERY':
      return { requestId: rid, payload: query(userId) };
    case 'action.devices.EXECUTE':
      return { requestId: rid, payload: execute(userId, input.payload && input.payload.commands || [], mqttHub) };
    default:
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

module.exports = { handleFulfillment, genAuthCode, exchangeCode, refreshAccessToken, CLIENT_ID, CLIENT_SECRET, REDIRECT };
