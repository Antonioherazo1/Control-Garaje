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
  return jwt.sign({ id: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpires,
  });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'no_token' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
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
