ALTER TABLE referrals
  ADD COLUMN inviter_eos_id VARCHAR(64) NULL,
  ADD COLUMN invited_eos_id VARCHAR(64) NULL,
  ADD COLUMN start_minutes INT UNSIGNED NULL,
  ADD COLUMN reward_status ENUM('pending', 'active', 'completed', 'blocked') NOT NULL DEFAULT 'pending',
  ADD COLUMN blocked_reason TEXT NULL,
  ADD COLUMN rewarded_completed_at TIMESTAMP NULL,
  ADD KEY idx_referrals_reward_status (guild_id, reward_status),
  ADD KEY idx_referrals_reward_invited_eos (guild_id, invited_eos_id);

CREATE TABLE IF NOT EXISTS referral_step_progress (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  referral_id BIGINT UNSIGNED NOT NULL,
  step_key VARCHAR(80) NOT NULL,
  required_minutes INT UNSIGNED NOT NULL,
  status ENUM('pending', 'retry', 'paid', 'failed', 'blocked') NOT NULL DEFAULT 'pending',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMP NULL,
  last_error TEXT NULL,
  paid_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_referral_step_progress_step (referral_id, step_key),
  KEY idx_referral_step_progress_retry (status, next_retry_at),
  CONSTRAINT fk_referral_step_progress_referral
    FOREIGN KEY (referral_id) REFERENCES referrals(id)
);

CREATE TABLE IF NOT EXISTS referral_reward_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  referral_id BIGINT UNSIGNED NOT NULL,
  step_key VARCHAR(80) NOT NULL,
  target_type ENUM('inviter', 'invited') NOT NULL,
  discord_id VARCHAR(32) NOT NULL,
  eos_id VARCHAR(64) NOT NULL,
  command TEXT NOT NULL,
  status ENUM('dry_run', 'success', 'failed') NOT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_referral_reward_logs_referral (referral_id, step_key),
  CONSTRAINT fk_referral_reward_logs_referral
    FOREIGN KEY (referral_id) REFERENCES referrals(id)
);

CREATE TABLE IF NOT EXISTS referral_reward_steps (
  step_key VARCHAR(80) PRIMARY KEY,
  label VARCHAR(120) NOT NULL,
  required_minutes INT UNSIGNED NOT NULL,
  inviter_commands JSON NOT NULL,
  invited_commands JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_referral_reward_steps_enabled (enabled, required_minutes)
);

INSERT INTO referral_reward_steps
  (step_key, label, required_minutes, inviter_commands, invited_commands, enabled)
VALUES
  ('10h', '10 Stunden', 600, JSON_ARRAY('addpoints {eos_id} 10000'), JSON_ARRAY('addpoints {eos_id} 5000'), TRUE),
  ('50h', '50 Stunden', 3000, JSON_ARRAY('addpoints {eos_id} 20000'), JSON_ARRAY('addpoints {eos_id} 10000'), TRUE),
  ('100h', '100 Stunden', 6000, JSON_ARRAY('addpoints {eos_id} 30000'), JSON_ARRAY('addpoints {eos_id} 15000'), TRUE)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  required_minutes = VALUES(required_minutes),
  inviter_commands = VALUES(inviter_commands),
  invited_commands = VALUES(invited_commands),
  enabled = VALUES(enabled);

CREATE TABLE IF NOT EXISTS referral_player_identities (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  discord_id VARCHAR(32) NOT NULL,
  discord_name VARCHAR(100) NULL,
  eos_id VARCHAR(64) NOT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_referral_player_identity_discord (guild_id, discord_id),
  KEY idx_referral_player_identity_eos (guild_id, eos_id)
);
