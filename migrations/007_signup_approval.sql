ALTER TABLE users
  MODIFY status ENUM('pending','active','disabled') NOT NULL DEFAULT 'active';
