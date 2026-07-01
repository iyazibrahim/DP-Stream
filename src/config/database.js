const fs = require('fs');

/**
 * In Docker Compose the MySQL service hostname is `db`.
 * Dokploy .env files often still have DB_HOST=127.0.0.1 from local dev — fix automatically.
 */
function resolveDbHost() {
  const configured = (process.env.DB_HOST || '').trim();
  const inDocker = fs.existsSync('/.dockerenv');

  if (inDocker && (!configured || configured === '127.0.0.1' || configured === 'localhost')) {
    return 'db';
  }

  return configured || '127.0.0.1';
}

module.exports = { resolveDbHost };
