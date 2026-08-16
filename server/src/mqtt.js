const mqtt = require('mqtt');
const config = require('./config');

const P = () => config.mqtt.prefix;
const TOPICS = {
  deviceStatus: `${P()}/device/status`,
  doorCmd: (n) => `${P()}/door/${n}/cmd`,
  doorState: (n) => `${P()}/door/${n}/state`,
  emergencyCmd: `${P()}/emergency/cmd`,
  testCmd: `${P()}/test/cmd`,
};

class MqttHub {
  constructor() {
    this.client = null;
    this.connected = false;
    this.deviceOnline = false;
    this.deviceInfo = {};
    this.doorStates = { door1: 'unknown', door2: 'unknown' };
    this.emergency = false;
    this._handlers = {};
  }

  on(event, cb) {
    (this._handlers[event] = this._handlers[event] || []).push(cb);
  }

  emit(event, data) {
    (this._handlers[event] || []).forEach((cb) => cb(data));
  }

  start() {
    const opts = {
      clientId: config.mqtt.clientId,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    };
    if (config.mqtt.username) opts.username = config.mqtt.username;
    if (config.mqtt.password) opts.password = config.mqtt.password;

    this.client = mqtt.connect(config.mqtt.url, opts);
    this.client.on('connect', () => this._onConnect());
    this.client.on('reconnect', () => console.log('[mqtt] reconectando...'));
    this.client.on('close', () => {
      this.connected = false;
      this.emit('change');
    });
    this.client.on('error', (e) => console.error('[mqtt] error:', e.message));
    this.client.on('message', (topic, payload) => this._onMessage(topic, payload.toString()));
  }

  _onConnect() {
    this.connected = true;
    console.log('[mqtt] conectado a', config.mqtt.url);
    [TOPICS.deviceStatus, TOPICS.emergencyCmd, TOPICS.doorState(1), TOPICS.doorState(2)].forEach((t) =>
      this.client.subscribe(t, { qos: 0 })
    );
    this.emit('change');
  }

  _onMessage(topic, payload) {
    if (topic === TOPICS.deviceStatus) {
      try {
        const msg = JSON.parse(payload);
        if (msg.status === 'offline') {
          this.deviceOnline = false;
        } else {
          this.deviceOnline = true;
          this.deviceInfo = msg;
        }
      } catch {
        this.deviceOnline = payload !== 'offline';
      }
    } else if (topic === TOPICS.emergencyCmd) {
      this.emergency = payload === 'stop';
    } else if (topic === TOPICS.doorState(1)) {
      this.doorStates.door1 = payload;
    } else if (topic === TOPICS.doorState(2)) {
      this.doorStates.door2 = payload;
    }
    this.emit('change');
  }

  publish(topic, msg) {
    if (!this.client || !this.connected) {
      console.warn('[mqtt] sin conexion, no se publico:', topic);
      return false;
    }
    this.client.publish(topic, String(msg));
    return true;
  }

  cmdDoor(channel, action) {
    return this.publish(TOPICS.doorCmd(channel), action);
  }

  testPulse() {
    return this.publish(TOPICS.testCmd, 'ping');
  }

  emergency(action) {
    return this.publish(TOPICS.emergencyCmd, action);
  }

  status() {
    return {
      broker: this.connected,
      deviceOnline: this.deviceOnline,
      deviceInfo: this.deviceInfo,
      doorStates: this.doorStates,
      emergency: this.emergency,
    };
  }
}

module.exports = { MqttHub };
