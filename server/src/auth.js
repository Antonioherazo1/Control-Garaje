const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPin(pin, salt, hash) {
  try {
    const calc = crypto.scryptSync(String(pin), String(salt), 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(String(hash), 'hex'));
  } catch {
    return false;
  }
}

function signToken(user) {
  const v = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
  // La sesion no caduca: solo se invalida al salir o al generar un PIN nuevo.
  return jwt.sign({ id: user.id, role: user.role, v }, config.jwtSecret);
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'no_token' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const db = require('./db');
    const u = db.getUser(payload.id);
    if (!u) {
      return res.status(401).json({ error: 'token_invalido' });
    }
    const tv = typeof u.tokenVersion === 'number' ? u.tokenVersion : 0;
    if (typeof payload.v === 'number') {
      if (payload.v !== tv) {
        return res.status(401).json({ error: 'token_invalido' });
      }
    } else {
      // Tokens antiguos sin version: aceptar solo si el usuario tiene version 0
      if (tv !== 0) {
        return res.status(401).json({ error: 'token_invalido' });
      }
    }
    req.userId = payload.id;
    req.userRole = payload.role;
    next();
  } catch {
    return res.status(401).json({ error: 'token_invalido' });
  }
}

function adminRequired(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = { hashPin, verifyPin, signToken, authRequired, adminRequired };
