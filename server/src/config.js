require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'cambia-esta-clave-por-seguridad',
  jwtExpires: process.env.JWT_EXPIRES || '8h',
  adminInitialPin: process.env.ADMIN_INITIAL_PIN || '1234',
  minPulseGapMs: parseInt(process.env.MIN_PULSE_GAP_MS || '500', 10),
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
  tuya: {
    enabled: (process.env.TUYA_ENABLED || 'false') === 'true',
    accessId: process.env.TUYA_ACCESS_ID || '',
    accessSecret: process.env.TUYA_ACCESS_SECRET || '',
    baseUrl: process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com',
    pollMs: parseInt(process.env.TUYA_POLL_MS || '20000', 10),
    door1DeviceId: process.env.TUYA_DOOR1_DEVICE_ID || '',
    door2DeviceId: process.env.TUYA_DOOR2_DEVICE_ID || '',
    door1Invert: (process.env.TUYA_DOOR1_INVERT || 'false') === 'true',
    door2Invert: (process.env.TUYA_DOOR2_INVERT || 'false') === 'true',
    autoCloseMs: {
      door1: parseInt(process.env.TUYA_AUTOCLOSE_DOOR1_MS || '0', 10),
      door2: parseInt(process.env.TUYA_AUTOCLOSE_DOOR2_MS || '0', 10),
    },
  },
};
