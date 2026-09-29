const crypto = require('crypto');

// Cliente de la Tuya Open API (IoT Core / Smart Home). Implementa la firma
// actual del SDK oficial: stringToSign = Metodo\nContent-SHA256\nHeaders\nURL
// y sign = HMAC-SHA256(secret, access_id + access_token + t + stringToSign)
// en hexadas mayusculas.
//
// Uso tipico:
//   const tuya = new TuyaClient({ door1DeviceId, autoCloseMs: {door1: 0, door2: 0} });
//   tuya.on('change', (data) => {...});
//   tuya.on('autoclose', ({ door }) => {...});
//   tuya.start();
class TuyaClient {
  constructor(opts) {
    this.accessId = opts.accessId || '';
    this.accessSecret = opts.accessSecret || '';
    this.baseUrl = (opts.baseUrl || 'https://openapi.tuyaus.com').replace(/\/+$/, '');
    this.pollMs = opts.pollMs || 20000;
    this.doors = [
      { key: 'door1', deviceId: opts.door1DeviceId || '', invert: !!opts.door1Invert },
      { key: 'door2', deviceId: opts.door2DeviceId || '', invert: !!opts.door2Invert },
    ];
    this.autoCloseMs = opts.autoCloseMs || { door1: 0, door2: 0 };

    this.token = null;
    this.tokenExpiresAt = 0;
    this.doorStates = { door1: 'unknown', door2: 'unknown' };
    this.battery = { door1: null, door2: null };
    this.lastError = '';
    this.lastPollAt = 0;
    this.online = false;
    this._timer = null;
    this._handlers = {};
    // Cada puerta con sensor recuerda desde cuando esta abierta y si ya se
    // disparo el cierre para la apertura en curso.
    this._openSince = { door1: 0, door2: 0 };
    this._closeSent = { door1: false, door2: false };
  }

  on(event, cb) {
    (this._handlers[event] = this._handlers[event] || []).push(cb);
  }

  emit(event, data) {
    (this._handlers[event] || []).forEach((cb) => cb(data));
  }

  _sign(method, path, params, bodyStr) {
    // Las peticiones de token (/v1.0/token) se firman SIN access_token.
    const isTokenReq = path.includes('/v1.0/token');
    // Content-SHA256 en minusculas del cuerpo (vacio -> hash de string vacio).
    const contentSha = crypto.createHash('sha256').update(bodyStr || '').digest('hex').toLowerCase();
    let url = path;
    if (params && Object.keys(params).length) {
      const keys = Object.keys(params).sort();
      url += '?' + keys.map((k) => `${k}=${params[k]}`).join('&');
    }
    // stringToSign = Metodo\nContent-SHA256\nHeaders\nURL (Headers vacio aqui).
    const stringToSign = `${method}\n${contentSha}\n\n${url}`;
    const t = String(Date.now());
    const msg = this.accessId + (isTokenReq ? '' : (this.token ? this.token.access_token : '')) + t + stringToSign;
    const sign = crypto.createHmac('sha256', this.accessSecret).update(msg).digest('hex').toUpperCase();
    return { sign, t };
  }

  async _request(method, path, params, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const { sign, t } = this._sign(method, path, params, bodyStr);
    const headers = {
      client_id: this.accessId,
      sign,
      sign_method: 'HMAC-SHA256',
      t,
    };
    if (this.token && !path.includes('/v1.0/token')) headers.access_token = this.token.access_token;
    if (bodyStr) headers['Content-Type'] = 'application/json';

    let url = this.baseUrl + path;
    if (params && Object.keys(params).length) {
      const keys = Object.keys(params).sort();
      url += '?' + keys.map((k) => `${k}=${params[k]}`).join('&');
    }
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr || undefined,
    });
    const json = await res.json();
    return json;
  }

  async _ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) return true;
    const res = await this._request('GET', '/v1.0/token', { grant_type: '1' });
    if (res && res.success && res.result && res.result.access_token) {
      this.token = res.result;
      this.tokenExpiresAt = Date.now() + (res.result.expire_time ? res.result.expire_time * 1000 : 7200000);
      console.log('[tuya] token obtenido, expira en', res.result.expire_time || 7200, 's');
      return true;
    }
    this.lastError = `token_error: ${res && res.msg ? res.msg : JSON.stringify(res).substring(0, 200)}`;
    console.error('[tuya] fallo token:', this.lastError);
    return false;
  }

  async _getDeviceStatus(deviceId) {
    // El estado real de estos sensores esta en la "thing shadow" (v2). El
    // endpoint iot-03/status devuelve [] hasta que el disp reporta mediante
    // eventos, mientras que shadow/properties mantiene el ultimo valor conocido.
    const eps = [
      `/v2.0/cloud/thing/${deviceId}/shadow/properties`,
      `/v1.0/iot-03/devices/${deviceId}/status`,
    ];
    for (const ep of eps) {
      const res = await this._request('GET', ep);
      if (ep.includes('shadow')) {
        if (res && res.success && res.result && Array.isArray(res.result.properties)) {
          return res.result.properties;
        }
      } else if (res && res.success && Array.isArray(res.result)) {
        return res.result;
      }
      console.warn(`[tuya] ${ep} -> success=${res && res.success} code=${res && res.code} msg=${res && res.msg}`);
    }
    return null;
  }

  // Convierte el array de DP del sensor a estado 'open'/'closed'. Maneja el
  // codigo 'contact'/'doorcontact_state' (bool) y enum 'open'/'closed'.
  // Convention de estos sensores: doorcontact_state true normalmente = cerrada.
  // Con `invert` se da vuelta si el fabricante lo reporta al reves.
  _mapContact(entries, invert) {
    if (!Array.isArray(entries)) return null;
    const contact = entries.find((e) => e && e.code && /contact/.test(e.code));
    if (!contact) return null;
    const v = contact.value;
    let open;
    if (v === 'open' || v === 'closed') {
      open = v === 'open';
    } else if (typeof v === 'boolean') {
      // true = cerrada (o abierta si invert).
      open = invert ? v : !v;
    } else if (typeof v === 'string') {
      const t = v === '1' || v.toLowerCase() === 'true';
      open = invert ? t : !t;
    } else {
      open = invert ? !!v : !v;
    }
    return open ? 'open' : 'closed';
  }

  _mapBattery(entries) {
    if (!Array.isArray(entries)) return null;
    const b = entries.find((e) => e && e.code && /battery/.test(e.code));
    if (!b) return null;
    const v = b.value;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v === 'high') return 90;
    if (v === 'middle' || v === 'mid') return 50;
    if (v === 'low') return 15;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  async _pollOnce() {
    if (!this.accessId || !this.accessSecret) {
      this.lastError = 'sin_credenciales';
      return;
    }
    if (!(await this._ensureToken())) return;

    let anyOk = false;
    for (const d of this.doors) {
      if (!d.deviceId) continue;
      try {
        const entries = await this._getDeviceStatus(d.deviceId);
        if (!entries) {
          this.lastError = `status_null_${d.key}`;
          continue;
        }
        anyOk = true;
        const st = this._mapContact(entries, d.invert);
        const bat = this._mapBattery(entries);
        if (st) this.doorStates[d.key] = st;
        if (bat !== null) this.battery[d.key] = bat;
        console.log(`[tuya] ${d.key} estado=${st || '?"'} battery=${bat} raw=${JSON.stringify(entries)?.substring(0, 200)}`);
        this._checkAutoClose(d, st);
      } catch (e) {
        this.lastError = `${d.key}: ${e.message}`;
        console.error(`[tuya] error consultando ${d.key}:`, e.message);
      }
    }
    this.online = anyOk;
    this.lastPollAt = Date.now();
    this.emit('change', {
      state: this.status(),
    });
  }

  _checkAutoClose(d, st) {
    const limit = this.autoCloseMs[d.key];
    if (!limit || !d.deviceId) return;
    if (st === 'open') {
      if (!this._openSince[d.key]) this._openSince[d.key] = Date.now();
      if (Date.now() - this._openSince[d.key] >= limit && !this._closeSent[d.key]) {
        this._closeSent[d.key] = true;
        console.log(`[tuya] ${d.key} abierta ${limit}ms; disparando cierre automatico`);
        this.emit('autoclose', { door: d.key });
      }
    } else if (st === 'closed') {
      this._openSince[d.key] = 0;
      this._closeSent[d.key] = false;
    }
  }

  start() {
    if (this._timer) return;
    this._pollOnce();
    this._timer = setInterval(() => this._pollOnce(), this.pollMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  status() {
    return {
      enabled: this._timer !== null || !!this.accessId,
      online: this.online,
      doorStates: this.doorStates,
      battery: this.battery,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
    };
  }
}

module.exports = { TuyaClient };