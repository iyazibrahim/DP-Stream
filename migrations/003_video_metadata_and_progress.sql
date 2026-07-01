ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS description TEXT NULL,
  ADD COLUMN IF NOT EXISTS thumbnail_path VARCHAR(500) NULL;

CREATE TABLE IF NOT EXISTS video_progress (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  video_id BIGINT NOT NULL,
  completed_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_video_progress_user_video (user_id, video_id),
  INDEX idx_video_progress_video_id (video_id)
);
