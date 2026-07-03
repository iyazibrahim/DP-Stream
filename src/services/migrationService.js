const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { resolveDbHost } = require('../config/database');

const migrationsDir = path.join(__dirname, '../../migrations');

async function tableExists(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT 1
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
     LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(conn, tableName, columnName) {
  const [rows] = await conn.query(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function statusEnumHasPending(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'status'
     LIMIT 1`
  );
  return String(rows[0]?.COLUMN_TYPE || '').includes('pending');
}

/** Detect migrations already applied via docker-entrypoint-initdb.d or older app bootstraps. */
const LEGACY_CHECKS = {
  '001_init.sql': (conn) => tableExists(conn, 'users'),
  '002_phase2_security.sql': (conn) => columnExists(conn, 'users', 'failed_login_attempts'),
  '003_video_metadata_and_progress.sql': (conn) => tableExists(conn, 'video_progress'),
  '004_courses_tags_jobs.sql': (conn) => tableExists(conn, 'transcode_jobs'),
  '005_watch_progress_fields.sql': (conn) => columnExists(conn, 'video_progress', 'last_position_seconds'),
  '006_video_display_order.sql': (conn) => columnExists(conn, 'videos', 'display_order'),
  '007_signup_approval.sql': (conn) => statusEnumHasPending(conn),
  '008_learning_content.sql': (conn) => tableExists(conn, 'learning_items')
};

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function isApplied(conn, version) {
  const [rows] = await conn.query('SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1', [version]);
  return rows.length > 0;
}

async function markApplied(conn, version) {
  await conn.query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [version]);
}

function listMigrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function createMigrationConnection() {
  return mysql.createConnection({
    host: resolveDbHost(),
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true
  });
}

async function runMigrations(logger) {
  const log = logger || { info: console.log, error: console.error };
  const files = listMigrationFiles();
  const conn = await createMigrationConnection();

  try {
    await ensureMigrationsTable(conn);

    for (const file of files) {
      if (await isApplied(conn, file)) {
        log.info({ migration: file }, 'Migration skip (already recorded)');
        continue;
      }

      const legacyCheck = LEGACY_CHECKS[file];
      if (legacyCheck && (await legacyCheck(conn))) {
        await markApplied(conn, file);
        log.info({ migration: file }, 'Migration skip (legacy schema detected)');
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      log.info({ migration: file }, 'Applying migration');
      await conn.query(sql);
      await markApplied(conn, file);
      log.info({ migration: file }, 'Migration applied');
    }
  } finally {
    await conn.end();
  }
}

module.exports = {
  runMigrations
};
