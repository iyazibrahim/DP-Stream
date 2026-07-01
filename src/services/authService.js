const bcrypt = require('bcrypt');
const { nanoid } = require('nanoid');

const SALT_ROUNDS = 12;

async function findUserByEmail(fastify, email) {
  const [rows] = await fastify.db.execute('SELECT * FROM users WHERE email = ? LIMIT 1', [email.toLowerCase().trim()]);
  return rows[0] || null;
}

async function createUser(fastify, data) {
  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
  const [result] = await fastify.db.execute(
    'INSERT INTO users (email, password_hash, role, status, must_reset_password, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [
      data.email.toLowerCase().trim(),
      passwordHash,
      data.role || 'viewer',
      data.status || 'active',
      data.mustResetPassword ? 1 : 0,
      data.createdBy || null
    ]
  );
  return result.insertId;
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

async function createSession(fastify, userId, request) {
  const sessionId = nanoid(32);
  await fastify.db.execute(
    'INSERT INTO sessions (session_id, user_id, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))',
    [sessionId, userId, request.ip, request.headers['user-agent'] || 'unknown']
  );
  return sessionId;
}

async function deleteSessionById(fastify, sessionId) {
  await fastify.db.execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
}

async function deleteSessionsByUser(fastify, userId) {
  await fastify.db.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

async function trimSessions(fastify, userId) {
  const maxSessions = Math.max(1, Number(process.env.MAX_ACTIVE_SESSIONS || 1));
  await fastify.db.execute(
    `DELETE FROM sessions
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ${maxSessions}
         ) keep_rows
       )`,
    [userId, userId]
  );
}

async function registerFailedLogin(fastify, userId) {
  const maxAttempts = Math.max(1, Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS || 5));
  const lockMinutes = Math.max(1, Number(process.env.LOGIN_LOCK_MINUTES || 15));
  await fastify.db.execute(
    `UPDATE users
     SET failed_login_attempts = IFNULL(failed_login_attempts, 0) + 1,
         locked_until = CASE
           WHEN IFNULL(failed_login_attempts, 0) + 1 >= ? THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
           ELSE locked_until
         END,
         updated_at = NOW()
     WHERE id = ?`,
    [maxAttempts, lockMinutes, userId]
  );
}

async function clearFailedLogin(fastify, userId) {
  await fastify.db.execute(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?',
    [userId]
  );
}

async function logEvent(fastify, payload) {
  await fastify.db.execute(
    'INSERT INTO audit_logs (actor_user_id, action, target_user_id, metadata) VALUES (?, ?, ?, ?)',
    [payload.actorUserId || null, payload.action, payload.targetUserId || null, JSON.stringify(payload.metadata || {})]
  );
}

module.exports = {
  findUserByEmail,
  createUser,
  verifyPassword,
  createSession,
  deleteSessionById,
  deleteSessionsByUser,
  trimSessions,
  registerFailedLogin,
  clearFailedLogin,
  logEvent
};
