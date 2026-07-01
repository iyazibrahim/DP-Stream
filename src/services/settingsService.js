async function getSetting(fastify, key) {
  const [rows] = await fastify.db.execute('SELECT `value` FROM settings WHERE `key` = ? LIMIT 1', [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(fastify, key, value) {
  await fastify.db.execute(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = CURRENT_TIMESTAMP',
    [key, String(value)]
  );
}

async function ensureDefaults(fastify) {
  const defaultSignup = (process.env.ALLOW_SIGNUP_DEFAULT || 'false').toLowerCase() === 'true' ? 'true' : 'false';
  const allowSignup = await getSetting(fastify, 'allow_public_signup');
  if (allowSignup === null) {
    await setSetting(fastify, 'allow_public_signup', defaultSignup);
  }
}

module.exports = {
  getSetting,
  setSetting,
  ensureDefaults
};
