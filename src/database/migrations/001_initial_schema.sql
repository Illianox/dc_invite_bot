CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_invites (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  inviter_discord_id VARCHAR(32) NOT NULL,
  invite_code VARCHAR(64) NOT NULL,
  channel_id VARCHAR(32) NOT NULL,
  status ENUM('active', 'deleted', 'replaced') NOT NULL DEFAULT 'active',
  active_inviter_discord_id VARCHAR(32)
    AS (CASE WHEN status = 'active' THEN inviter_discord_id ELSE NULL END) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  UNIQUE KEY uq_user_invites_code (guild_id, invite_code),
  UNIQUE KEY uq_user_invites_active (guild_id, active_inviter_discord_id),
  KEY idx_user_invites_status (guild_id, status)
);

CREATE TABLE IF NOT EXISTS referrals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  inviter_discord_id VARCHAR(32) NULL,
  invitee_discord_id VARCHAR(32) NOT NULL,
  invite_code VARCHAR(64) NULL,
  joined_at TIMESTAMP NOT NULL,
  status ENUM('pending', 'qualified', 'unqualified', 'left', 'unresolved', 'revoked', 'non_referral') NOT NULL,
  active_invitee_discord_id VARCHAR(32)
    AS (
      CASE WHEN status IN ('pending', 'qualified', 'unqualified')
      THEN invitee_discord_id ELSE NULL END
    ) STORED,
  qualified_at TIMESTAMP NULL,
  left_at TIMESTAMP NULL,
  resolved_by_admin_id VARCHAR(32) NULL,
  resolution_reason TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_referrals_active_invitee (guild_id, active_invitee_discord_id),
  KEY idx_referrals_inviter_status (guild_id, inviter_discord_id, status),
  KEY idx_referrals_invitee (guild_id, invitee_discord_id)
);

CREATE TABLE IF NOT EXISTS referral_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  referral_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  old_status VARCHAR(30) NULL,
  new_status VARCHAR(30) NOT NULL,
  actor_discord_id VARCHAR(32) NULL,
  reason TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_referral_events_referral FOREIGN KEY (referral_id) REFERENCES referrals(id)
);

CREATE TABLE IF NOT EXISTS invite_snapshots (
  invite_code VARCHAR(64) PRIMARY KEY,
  known_uses INT UNSIGNED NOT NULL DEFAULT 0,
  captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  baseline_reason ENUM('startup', 'join_processed', 'invite_created', 'recovery') NOT NULL
);

CREATE TABLE IF NOT EXISTS join_processing_queue (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  invitee_discord_id VARCHAR(32) NOT NULL,
  invitee_discord_name VARCHAR(100) NULL,
  joined_at TIMESTAMP NOT NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP NULL,
  last_error TEXT NULL,
  status ENUM('queued', 'processing', 'resolved', 'failed') NOT NULL DEFAULT 'queued',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_join_queue_ready (guild_id, status, next_attempt_at)
);

CREATE TABLE IF NOT EXISTS panel_messages (
  panel_type ENUM('main_panel', 'public_ranking', 'public_ranking_monthly', 'public_ranking_all_time') NOT NULL,
  guild_id VARCHAR(32) NOT NULL,
  channel_id VARCHAR(32) NOT NULL,
  message_id VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, panel_type)
);

CREATE TABLE IF NOT EXISTS bot_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  severity ENUM('info', 'warn', 'error') NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  discord_user_id VARCHAR(32) NULL,
  referral_id BIGINT UNSIGNED NULL,
  details TEXT NOT NULL,
  discord_delivery_status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  discord_sent_at TIMESTAMP NULL,
  discord_attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  discord_next_attempt_at TIMESTAMP NULL,
  discord_last_error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bot_logs_dispatch (discord_delivery_status, discord_next_attempt_at)
);
