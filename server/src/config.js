require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'cambia-esta-clave-por-seguridad',
  jwtExpires: process.env.JWT_EXPIRES || '8h',
  adminInitialPin: process.env.ADMIN_INITIAL_PIN || '1234',
  minPulseGapMs: parseInt(process.env.MIN_PULSE_GAP_MS || '1500', 10),
  maxHistory: parseInt(process.env.MAX_HISTORY || '2000', 10),
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://127.0.0.1:1884',
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    prefix: (process.env.MQTT_PREFIX || 'garaje').replace(/\/+$/, ''),
    clientId: process.env.MQTT_CLIENT_ID || 'garaje-server',
  },
  dataDir: path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, '..', 'web'),
};
