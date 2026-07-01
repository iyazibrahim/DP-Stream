SET @has_last_position := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'video_progress'
    AND COLUMN_NAME = 'last_position_seconds'
);
SET @sql_last_position := IF(
  @has_last_position = 0,
  'ALTER TABLE video_progress ADD COLUMN last_position_seconds INT NOT NULL DEFAULT 0 AFTER video_id',
  'SELECT 1'
);
PREPARE stmt_last_position FROM @sql_last_position;
EXECUTE stmt_last_position;
DEALLOCATE PREPARE stmt_last_position;

SET @has_duration := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'video_progress'
    AND COLUMN_NAME = 'duration_seconds'
);
SET @sql_duration := IF(
  @has_duration = 0,
  'ALTER TABLE video_progress ADD COLUMN duration_seconds INT NOT NULL DEFAULT 0 AFTER last_position_seconds',
  'SELECT 1'
);
PREPARE stmt_duration FROM @sql_duration;
EXECUTE stmt_duration;
DEALLOCATE PREPARE stmt_duration;

SET @has_last_watched := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'video_progress'
    AND COLUMN_NAME = 'last_watched_at'
);
SET @sql_last_watched := IF(
  @has_last_watched = 0,
  'ALTER TABLE video_progress ADD COLUMN last_watched_at TIMESTAMP NULL AFTER completed_at',
  'SELECT 1'
);
PREPARE stmt_last_watched FROM @sql_last_watched;
EXECUTE stmt_last_watched;
DEALLOCATE PREPARE stmt_last_watched;

SET @has_progress_idx := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'video_progress'
    AND INDEX_NAME = 'idx_video_progress_user_video_updated'
);
SET @sql_progress_idx := IF(
  @has_progress_idx = 0,
  'CREATE INDEX idx_video_progress_user_video_updated ON video_progress (user_id, video_id, updated_at)',
  'SELECT 1'
);
PREPARE stmt_progress_idx FROM @sql_progress_idx;
EXECUTE stmt_progress_idx;
DEALLOCATE PREPARE stmt_progress_idx;