-- Idempotent: adds display_order column to videos table for admin-controlled viewer listing order
SET @has_display_order := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'videos'
    AND COLUMN_NAME = 'display_order'
);
SET @sql_display_order := IF(
  @has_display_order = 0,
  'ALTER TABLE videos ADD COLUMN display_order INT NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE stmt_display_order FROM @sql_display_order;
EXECUTE stmt_display_order;
DEALLOCATE PREPARE stmt_display_order;

-- Idempotent: add index on display_order for fast ordering queries
SET @has_display_order_idx := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'videos'
    AND INDEX_NAME = 'idx_videos_display_order'
);
SET @sql_display_order_idx := IF(
  @has_display_order_idx = 0,
  'CREATE INDEX idx_videos_display_order ON videos (display_order)',
  'SELECT 1'
);
PREPARE stmt_display_order_idx FROM @sql_display_order_idx;
EXECUTE stmt_display_order_idx;
DEALLOCATE PREPARE stmt_display_order_idx;
