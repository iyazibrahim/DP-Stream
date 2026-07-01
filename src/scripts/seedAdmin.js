require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function run() {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error('Usage: npm run db:seed-admin -- <email> <password>');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const hash = await bcrypt.hash(password, 12);
  await conn.execute(
    'INSERT INTO users (email, password_hash, role, status, must_reset_password) VALUES (?, ?, "admin", "active", 0) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = "admin", status = "active", must_reset_password = 0, failed_login_attempts = 0, locked_until = NULL',
    [email.toLowerCase().trim(), hash]
  );

  await conn.end();
  console.log('Admin user created/updated successfully.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
