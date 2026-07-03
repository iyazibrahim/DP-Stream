ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS thumbnail_path VARCHAR(500) NULL;

CREATE TABLE IF NOT EXISTS learning_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  thumbnail_path VARCHAR(500) NULL,
  tags VARCHAR(255) NULL,
  item_type ENUM('premium_video', 'free_video', 'external_video', 'document') NOT NULL DEFAULT 'premium_video',
  access_level ENUM('public', 'authenticated') NOT NULL DEFAULT 'authenticated',
  status ENUM('processing', 'published', 'hidden', 'failed') NOT NULL DEFAULT 'processing',
  display_order INT NOT NULL DEFAULT 0,
  video_id BIGINT NULL,
  external_url VARCHAR(1000) NULL,
  external_provider VARCHAR(50) NULL,
  external_video_id VARCHAR(100) NULL,
  document_path VARCHAR(600) NULL,
  document_mime VARCHAR(120) NULL,
  document_filename VARCHAR(255) NULL,
  source_path VARCHAR(600) NULL,
  created_by BIGINT NOT NULL,
  published_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_learning_items_type (item_type),
  INDEX idx_learning_items_access (access_level),
  INDEX idx_learning_items_status (status),
  INDEX idx_learning_items_video (video_id),
  INDEX idx_learning_items_order (display_order)
);

CREATE TABLE IF NOT EXISTS course_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  course_id BIGINT NOT NULL,
  learning_item_id BIGINT NOT NULL,
  order_index INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_course_learning_item (course_id, learning_item_id),
  INDEX idx_course_items_course (course_id),
  INDEX idx_course_items_item (learning_item_id)
);

CREATE TABLE IF NOT EXISTS item_progress (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  learning_item_id BIGINT NOT NULL,
  last_position_seconds INT NOT NULL DEFAULT 0,
  duration_seconds INT NOT NULL DEFAULT 0,
  completed_at TIMESTAMP NULL,
  last_watched_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_item_progress (user_id, learning_item_id),
  INDEX idx_item_progress_user (user_id),
  INDEX idx_item_progress_item (learning_item_id)
);

INSERT INTO learning_items (
  title, description, thumbnail_path, tags, item_type, access_level, status,
  display_order, video_id, created_by, published_at, created_at, updated_at
)
SELECT
  v.title,
  v.description,
  v.thumbnail_path,
  v.tags,
  'premium_video',
  'authenticated',
  v.status,
  v.display_order,
  v.id,
  v.uploaded_by,
  v.published_at,
  v.created_at,
  v.updated_at
FROM videos v
WHERE NOT EXISTS (
  SELECT 1 FROM learning_items li WHERE li.video_id = v.id
);

INSERT INTO course_items (course_id, learning_item_id, order_index, created_at)
SELECT cv.course_id, li.id, cv.order_index, cv.created_at
FROM course_videos cv
INNER JOIN learning_items li ON li.video_id = cv.video_id
WHERE NOT EXISTS (
  SELECT 1 FROM course_items ci
  WHERE ci.course_id = cv.course_id AND ci.learning_item_id = li.id
);
