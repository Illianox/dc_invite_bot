CREATE TABLE IF NOT EXISTS referral_reward_claims (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  claim_code VARCHAR(120) NOT NULL,
  referral_id BIGINT UNSIGNED NOT NULL,
  step_key VARCHAR(80) NOT NULL,
  target_type ENUM('inviter', 'invited') NOT NULL,
  discord_id VARCHAR(32) NOT NULL,
  eos_id VARCHAR(64) NOT NULL,
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_referral_reward_claim_code (claim_code),
  UNIQUE KEY uq_referral_reward_claim_reward (referral_id, step_key, target_type),
  KEY idx_referral_reward_claims_open (discord_id, expires_at),
  KEY idx_referral_reward_claims_referral (referral_id),
  CONSTRAINT fk_referral_reward_claims_referral
    FOREIGN KEY (referral_id) REFERENCES referrals(id)
);
