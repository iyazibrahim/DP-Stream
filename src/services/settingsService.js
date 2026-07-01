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

async function columnExists(fastify, tableName, columnName) {
  const [rows] = await fastify.db.execute(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return Boolean(rows[0]);
}

async function ensureSecuritySchema(fastify) {
  const hasFailedAttempts = await columnExists(fastify, 'users', 'failed_login_attempts');
  if (!hasFailedAttempts) {
    await fastify.db.execute('ALTER TABLE users ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0');
  }

  const hasLockedUntil = await columnExists(fastify, 'users', 'locked_until');
  if (!hasLockedUntil) {
    await fastify.db.execute('ALTER TABLE users ADD COLUMN locked_until TIMESTAMP NULL');
  }
}

async function ensureVideoSchema(fastify) {
  const hasDescription = await columnExists(fastify, 'videos', 'description');
  if (!hasDescription) {
    await fastify.db.execute('ALTER TABLE videos ADD COLUMN description TEXT NULL');
  }

  const hasThumbnailPath = await columnExists(fastify, 'videos', 'thumbnail_path');
  if (!hasThumbnailPath) {
    await fastify.db.execute('ALTER TABLE videos ADD COLUMN thumbnail_path VARCHAR(500) NULL');
  }

  const hasTags = await columnExists(fastify, 'videos', 'tags');
  if (!hasTags) {
    await fastify.db.execute('ALTER TABLE videos ADD COLUMN tags VARCHAR(255) NULL');
  }

  await fastify.db.execute(
    `CREATE TABLE IF NOT EXISTS video_progress (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      video_id BIGINT NOT NULL,
      completed_at TIMESTAMP NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_video_progress_user_video (user_id, video_id),
      INDEX idx_video_progress_video_id (video_id)
    )`
  );

  await fastify.db.execute(
    `CREATE TABLE IF NOT EXISTS courses (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      thumbnail_path VARCHAR(500) NULL,
      description TEXT NULL,
      created_by BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  );

  const hasCourseThumbnail = await columnExists(fastify, 'courses', 'thumbnail_path');
  if (!hasCourseThumbnail) {
    await fastify.db.execute('ALTER TABLE courses ADD COLUMN thumbnail_path VARCHAR(500) NULL');
  }

  await fastify.db.execute(
    `CREATE TABLE IF NOT EXISTS course_videos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      course_id BIGINT NOT NULL,
      video_id BIGINT NOT NULL,
      order_index INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_course_video (course_id, video_id),
      INDEX idx_course_videos_course (course_id),
      INDEX idx_course_videos_video (video_id)
    )`
  );

  await fastify.db.execute(
    `CREATE TABLE IF NOT EXISTS transcode_jobs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      video_id BIGINT NOT NULL,
      upload_path VARCHAR(600) NOT NULL,
      output_path VARCHAR(600) NOT NULL,
      status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      started_at TIMESTAMP NULL,
      completed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_transcode_jobs_video_id (video_id),
      INDEX idx_transcode_jobs_status (status)
    )`
  );
}

async function ensureSignupApprovalSchema(fastify) {
  const [rows] = await fastify.db.execute(
    `SELECT COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'status'
     LIMIT 1`
  );
  const columnType = String(rows[0]?.COLUMN_TYPE || '');
  if (!columnType.includes('pending')) {
    await fastify.db.execute(
      "ALTER TABLE users MODIFY status ENUM('pending','active','disabled') NOT NULL DEFAULT 'active'"
    );
  }
}

async function ensureDefaults(fastify) {
  await ensureSecuritySchema(fastify);
  await ensureSignupApprovalSchema(fastify);
  await ensureVideoSchema(fastify);
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
