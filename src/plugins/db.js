const fp = require('fastify-plugin');
const mysql = require('mysql2/promise');
const { resolveDbHost } = require('../config/database');

module.exports = fp(async function dbPlugin(fastify) {
  const dbHost = resolveDbHost();
  const connectionLimit = Math.max(5, Number(process.env.DB_POOL_MAX || 30));
  const pool = mysql.createPool({
    host: dbHost,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit
  });

  try {
    const conn = await pool.getConnection();
    conn.release();
  } catch (err) {
    fastify.log.error(
      {
        dbHost,
        dbUser: process.env.DB_USER,
        dbName: process.env.DB_NAME,
        code: err.code,
        message: err.message
      },
      'MySQL connection failed — check DB_PASSWORD matches the db volume (run scripts/sync-mysql-user.sh or reset db_data volume)'
    );
    throw err;
  }

  fastify.decorate('db', pool);
  fastify.log.info({ dbHost, dbPort: Number(process.env.DB_PORT || 3306) }, 'MySQL pool configured');

  fastify.addHook('onClose', async () => {
    await pool.end();
  });
});
