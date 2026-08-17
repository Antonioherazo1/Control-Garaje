const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function readJSON(file, fallback) {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const users = readJSON(path.join(config.dataDir, 'users.json'), []);
let history = readJSON(path.join(config.dataDir, 'history.json'), []);
const usage = readJSON(path.join(config.dataDir, 'usage.json'), {});
let voiceTokens = readJSON(path.join(config.dataDir, 'voice-tokens.json'), []);

function saveUsers() {
  writeJSON(path.join(config.dataDir, 'users.json'), users);
}

function saveHistory() {
  writeJSON(path.join(config.dataDir, 'history.json'), history);
}

function saveUsage() {
  writeJSON(path.join(config.dataDir, 'usage.json'), usage);
}

function saveVoiceTokens() {
  writeJSON(path.join(config.dataDir, 'voice-tokens.json'), voiceTokens);
}

function getVoiceToken(id) {
  return voiceTokens.find((t) => t.id === id);
}

function addVoiceToken(name, door) {
  const crypto = require('crypto');
  const token = {
    id: 'v_' + crypto.randomBytes(16).toString('hex'),
    name: String(name || 'Voice'),
    door: String(door || 'door1'),
    createdAt: Date.now(),
  };
  voiceTokens.push(token);
  saveVoiceTokens();
  return token;
}

function deleteVoiceToken(id) {
  const i = voiceTokens.findIndex((t) => t.id === id);
  if (i < 0) return false;
  voiceTokens.splice(i, 1);
  saveVoiceTokens();
  return true;
}

function getVoiceTokens() {
  return voiceTokens.map((t) => ({
    id: t.id,
    name: t.name,
    door: t.door,
    createdAt: t.createdAt,
    url: `https://garaje.thinc.site/api/voice?token=${t.id}`,
  }));
}

function getUser(id) {
  return users.find((u) => u.id === String(id));
}

function getUserByName(name) {
  return users.find((u) => u.id === String(name) || u.name === String(name));
}

function addUser(user) {
  users.push(user);
  saveUsers();
  return user;
}

function updateUser(id, patch) {
  const i = users.findIndex((u) => u.id === String(id));
  if (i < 0) return null;
  users[i] = { ...users[i], ...patch, id: String(id) };
  saveUsers();
  return users[i];
}

function deleteUser(id) {
  const i = users.findIndex((u) => u.id === String(id));
  if (i < 0) return false;
  users.splice(i, 1);
  saveUsers();
  return true;
}

function addHistory(entry) {
  history.push(entry);
  if (history.length > config.maxHistory) {
    history = history.slice(-config.maxHistory);
  }
  saveHistory();
}

function getHistory({ user, limit } = {}) {
  let list = user ? history.filter((e) => e.user === user) : history.slice();
  return list.slice(-(limit || 100)).reverse();
}

function usageKey(userId) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${userId}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function usedToday(userId) {
  return usage[usageKey(userId)] || 0;
}

function recordUsage(userId) {
  const k = usageKey(userId);
  usage[k] = (usage[k] || 0) + 1;
  saveUsage();
}

function seedAdminIfNeeded() {
  if (users.length > 0) return;
  const { hashPin } = require('./auth');
  const pin = config.adminInitialPin;
  const { salt, hash } = hashPin(pin);
  users.push({
    id: 'admin',
    name: 'Administrador',
    role: 'admin',
    salt,
    pinHash: hash,
    doors: ['door1', 'door2'],
    schedule: { start: '00:00', end: '23:59' },
    dailyLimit: 0,
    expiresAt: null,
  });
  saveUsers();
  console.warn(`[db] Usuario admin creado con PIN inicial "${pin}". CAMBIALO cuanto antes.`);
}

module.exports = {
  users,
  history,
  usage,
  getUser,
  getUserByName,
  addUser,
  updateUser,
  deleteUser,
  addHistory,
  getHistory,
  usedToday,
  recordUsage,
  seedAdminIfNeeded,
  getVoiceToken,
  getVoiceTokens,
  addVoiceToken,
  deleteVoiceToken,
};
