const db = require('./db');

function nowHM() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inSchedule(schedule, now) {
  if (!schedule || !schedule.start || !schedule.end) return true;
  const start = schedule.start;
  const end = schedule.end;
  if (start === end) return true;
  if (start < end) return now >= start && now <= end;
  return now >= start || now <= end;
}

function checkAccess(user, door) {
  if (!user) return { allowed: false, reason: 'usuario_no_existe' };
  if (user.expiresAt && Date.now() > user.expiresAt) {
    return { allowed: false, reason: 'pin_expirado' };
  }
  if (user.role !== 'admin') {
    if (!Array.isArray(user.doors) || !user.doors.includes(door)) {
      return { allowed: false, reason: 'puerta_no_permitida' };
    }
    if (!inSchedule(user.schedule, nowHM())) {
      return { allowed: false, reason: 'fuera_de_horario' };
    }
  }
  if (user.dailyLimit > 0 && db.usedToday(user.id) >= user.dailyLimit) {
    return { allowed: false, reason: 'limite_diario' };
  }
  return { allowed: true };
}

module.exports = { checkAccess, nowHM, inSchedule };
