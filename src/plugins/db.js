const fp = require('fastify-plugin');
const mysql = require('mysql2/promise');

module.exports = fp(async function dbPlugin(fastify) {
  const connectionLimit = Math.max(5, Number(process.env.DB_POOL_MAX || 30));
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit
  });

  fastify.decorate('db', pool);

  fastify.addHook('onClose', async () => {
    await pool.end();
  });
});
